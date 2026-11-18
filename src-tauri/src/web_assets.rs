use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{borrow::Cow, collections::BTreeMap, path::{Component, Path, PathBuf}};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

#[derive(Deserialize, Serialize)]
struct Manifest {
    version: String,
    files: BTreeMap<String, String>,
}

/// 前端文件从安装目录的 web 加载，macOS 使用应用包的 Resources/web；程序仅保存摘要清单。
pub struct DiskAssets {
    root: PathBuf,
    manifest: Manifest,
}

/// macOS 应用包的可执行文件和资源分别位于 Contents/MacOS 与 Contents/Resources。
/// 未打包的开发二进制继续使用旁边的 web，应用包缺失资源时不回退到其他目录。
fn resource_root(executable: &Path, macos: bool) -> PathBuf {
    let directory = executable.parent().expect("无法确定 DBFolio 安装目录");
    if macos && directory.file_name().is_some_and(|name| name == "MacOS") {
        if let Some(contents) = directory.parent().filter(|path| {
            path.file_name().is_some_and(|name| name == "Contents")
                && path.parent().is_some_and(|bundle| {
                    bundle.extension().is_some_and(|extension| extension == "app")
                })
        }) {
            return contents.join("Resources").join("web");
        }
    }
    directory.join("web")
}

impl DiskAssets {
    /// 只备份 EXE 内登记并通过摘要验证的资源，不复制程序目录内的用户文件。
    pub fn backup_to(&self, destination: &Path) -> Result<(), String> {
        self.validate()?;
        std::fs::create_dir_all(destination).map_err(|e|e.to_string())?;
        for name in self.manifest.files.keys() {
            let bytes=self.read(name)?;
            let path=destination.join(name);
            if let Some(parent)=path.parent(){std::fs::create_dir_all(parent).map_err(|e|e.to_string())?;}
            std::fs::OpenOptions::new().write(true).create_new(true).open(path)
                .and_then(|mut f|{use std::io::Write;f.write_all(&bytes)?;f.sync_all()}).map_err(|e|e.to_string())?;
        }
        std::fs::write(destination.join("web-manifest.json"),serde_json::to_vec_pretty(&self.manifest).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
    }
    #[cfg(feature = "custom-protocol")]
    pub fn packaged() -> Self {
        let executable = std::env::current_exe().expect("无法确定 DBFolio 安装目录");
        Self {
            root: resource_root(&executable, cfg!(target_os = "macos")),
            manifest: serde_json::from_str(include_str!("../../dist/web-manifest.json"))
                .expect("构建时的前端资源清单无效，请重新运行 npm run build"),
        }
    }

    fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        let expected = self.manifest.files.get(name).ok_or_else(|| format!("未登记的资源：{name}"))?;
        let path = Path::new(name);
        if name.contains(['\\', ':']) || path.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err("无效的资源路径".into());
        }
        let root = self.root.canonicalize().map_err(|_| "缺少 web 资源目录，请完整解压便携包或重新安装。".to_owned())?;
        let file = root.join(path).canonicalize().map_err(|_| format!("缺少资源：{name}"))?;
        if !file.starts_with(&root) { return Err("资源路径超出安装目录".into()); }
        let bytes = std::fs::read(file).map_err(|_| format!("无法读取资源：{name}"))?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if &actual != expected { return Err(format!("资源损坏或版本不匹配：{name}")); }
        Ok(bytes)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.manifest.version != env!("CARGO_PKG_VERSION") {
            return Err("前端与程序版本不匹配，请重新构建并完整替换程序目录。".into());
        }
        if !self.manifest.files.contains_key("index.html") { return Err("资源清单缺少 index.html".into()); }
        for name in self.manifest.files.keys() { self.read(name)?; }
        Ok(())
    }
}

impl<R: tauri::Runtime> tauri::Assets<R> for DiskAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.read(key.as_ref().strip_prefix('/')?).ok().map(Cow::Owned)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(self.manifest.files.keys().filter_map(|name| {
            self.read(name).ok().map(|bytes| (Cow::Owned(format!("/{name}")), Cow::Owned(bytes)))
        }))
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Assets;

    #[test]
    fn distribution_layouts_load_their_own_verified_resources() {
        let temp = tempfile::tempdir().unwrap();
        let cases = [
            (temp.path().join("portable/DBFolio.exe"), false, temp.path().join("portable/web")),
            (temp.path().join("DBFolio.app/Contents/MacOS/dbfolio"), true,
                temp.path().join("DBFolio.app/Contents/Resources/web")),
            (temp.path().join("unbundled/dbfolio"), true, temp.path().join("unbundled/web")),
        ];
        for (executable, macos, expected) in cases {
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::create_dir_all(&expected).unwrap();
            std::fs::write(expected.join("index.html"), b"verified page").unwrap();
            let provider = DiskAssets {
                root: resource_root(&executable, macos),
                manifest: Manifest {
                    version: env!("CARGO_PKG_VERSION").into(),
                    files: BTreeMap::from([("index.html".into(),
                        format!("{:x}", Sha256::digest(b"verified page")))]),
                },
            };
            assert_eq!(provider.root, expected);
            provider.validate().unwrap();
            assert_eq!(provider.read("index.html").unwrap(), b"verified page");
            // 包内缺失资源时，不能误读可执行文件旁边的同名目录。
            if executable.parent().unwrap().file_name().unwrap() == "MacOS" {
                let adjacent = executable.parent().unwrap().join("web");
                std::fs::create_dir(&adjacent).unwrap();
                std::fs::write(adjacent.join("index.html"), b"verified page").unwrap();
                std::fs::remove_file(expected.join("index.html")).unwrap();
                assert!(provider.validate().unwrap_err().contains("缺少资源"));
            }
        }
    }

    #[test]
    fn external_assets_reject_missing_modified_and_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("web");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("index.html"), b"page").unwrap();
        std::fs::write(temp.path().join("secret"), b"secret").unwrap();
        let mut provider = DiskAssets { root, manifest: Manifest {
            version: env!("CARGO_PKG_VERSION").into(),
            files: BTreeMap::from([("index.html".into(), format!("{:x}", Sha256::digest(b"page")))])
        }};
        provider.validate().unwrap();
        let backup=temp.path().join("verified-backup");provider.backup_to(&backup).unwrap();
        assert_eq!(std::fs::read(backup.join("index.html")).unwrap(),b"page");
        assert!(!backup.join("secret").exists());
        assert_eq!(<DiskAssets as Assets<tauri::Wry>>::get(&provider, &AssetKey::from("/index.html")).unwrap().as_ref(), b"page");
        assert!(provider.read("../secret").is_err());
        provider.manifest.files.insert("../secret".into(), format!("{:x}", Sha256::digest(b"secret")));
        assert!(provider.read("../secret").is_err());
        provider.manifest.files.remove("../secret");
        std::fs::write(provider.root.join("index.html"), b"changed").unwrap();
        assert!(provider.validate().unwrap_err().contains("不匹配"));
        std::fs::remove_file(provider.root.join("index.html")).unwrap();
        assert!(provider.validate().unwrap_err().contains("缺少资源"));
        provider.manifest.version = "0.0.0".into();
        assert!(provider.validate().unwrap_err().contains("版本不匹配"));
    }
}
