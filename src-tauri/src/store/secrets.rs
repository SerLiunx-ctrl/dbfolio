use crate::error::AppResult;

const SERVICE_NAME: &str = "data-workbench";

pub fn save_password(session_id: &str, password: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, session_id)?;
    entry.set_password(password)?;
    Ok(())
}

pub fn load_password(session_id: &str) -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(SERVICE_NAME, session_id)?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn delete_password(session_id: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, session_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub fn save_ssh(id:&str,input:&crate::store::SessionInput)->AppResult<()> {
    for (suffix,value) in [("ssh-password",&input.ssh_password),("ssh-key-passphrase",&input.ssh_key_passphrase)] {
        let key=format!("{id}:{suffix}");
        match value.as_deref(){None=>{},Some("")=>delete_password(&key)?,Some(v)=>save_password(&key,v)?}
    }
    Ok(())
}
