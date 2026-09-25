use serde::ser::{Serialize, SerializeStruct, Serializer};

#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Cancelled(String),
    #[error("{0}")]
    Message(String),
    #[error("{0}")]
    WriteUncertain(String),
    #[error("{0}")]
    Connection(String),
    #[error("{0}")]
    Database(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    ReadOnly(String),
    #[error("{0}")]
    Dangerous(String),
    #[error("凭据操作失败: {0}")]
    Secret(String),
    #[error("{0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Cancelled(_) => "E_CANCELLED",
            AppError::Message(_) => "E_MESSAGE",
            AppError::WriteUncertain(_) => "E_WRITE_UNCERTAIN",
            AppError::Connection(_) => "E_CONN",
            AppError::Database(_) => "E_SQL_EXEC",
            AppError::NotFound(_) => "E_NOT_FOUND",
            AppError::InvalidInput(_) => "E_INVALID",
            AppError::ReadOnly(_) => "E_READONLY",
            AppError::Dangerous(_) => "E_DANGEROUS",
            AppError::Secret(_) => "E_SECRET",
            AppError::Internal(_) => "E_INTERNAL",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            AppError::Connection(d) | AppError::Database(d) | AppError::Internal(d) => {
                Some(d.clone())
            }
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.serialize_field("detail", &self.detail())?;
        s.end()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        match &value {
            sqlx::Error::Database(db) => AppError::Database(db.message().to_string()),
            sqlx::Error::PoolTimedOut => AppError::Connection("连接超时".into()),
            sqlx::Error::Io(err) => AppError::Connection(err.to_string()),
            _ => AppError::Internal(value.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Internal(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Internal(value.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(value: keyring::Error) -> Self {
        AppError::Secret(value.to_string())
    }
}
