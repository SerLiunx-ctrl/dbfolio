use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{borrow::Cow, collections::BTreeMap, path::{Component, Path, PathBuf}};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

#[derive(Deserialize)]
struct Manifest {
    version: String,
    files: BTreeMap<String, String>,
}

/// 前端文件从 EXE 同目录的 web 加载；EXE 仅保存构建时的摘要清单。
pub struct DiskAssets {
    root: PathBuf,
    manifest: Manifest,
}

impl DiskAssets {
    #[cfg(feature = "custom-protocol")]
    pub fn packaged() -> Self {
        let executable = std::env::current_exe().expect("无法确定 DBFolio 安装目录");
        Self {
            root: executable.parent().expect("无法确定 DBFolio 安装目录").join("web"),
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
