use std::path::Path;

use reqwest::Url;

use crate::error::CoreError;

pub(super) fn resolve_auth(
    user: Option<&str>,
    pass: Option<&str>,
    cookie_file: Option<&Path>,
) -> Result<Option<(String, String)>, CoreError> {
    match (user, pass) {
        (Some(u), Some(p)) => return Ok(Some((u.to_owned(), p.to_owned()))),
        (Some(_), None) | (None, Some(_)) => {
            return Err(CoreError::InvalidTxData(
                "both rpc user and rpc pass must be set together".to_owned(),
            ));
        }
        (None, None) => {}
    }

    let Some(cookie_file) = cookie_file else {
        return Ok(None);
    };

    let content = std::fs::read_to_string(cookie_file).map_err(|e| {
        CoreError::InvalidTxData(format!(
            "failed to read rpc cookie file {}: {e}",
            cookie_file.display()
        ))
    })?;
    let line = content
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| {
            CoreError::InvalidTxData(format!(
                "rpc cookie file {} is empty",
                cookie_file.display()
            ))
        })?;

    let (cookie_user, cookie_pass) = line.split_once(':').ok_or_else(|| {
        CoreError::InvalidTxData(format!(
            "rpc cookie file {} must contain `username:password`",
            cookie_file.display()
        ))
    })?;
    if cookie_user.is_empty() || cookie_pass.is_empty() {
        return Err(CoreError::InvalidTxData(format!(
            "rpc cookie file {} must contain non-empty `username:password`",
            cookie_file.display()
        )));
    }

    Ok(Some((cookie_user.to_owned(), cookie_pass.to_owned())))
}

pub(super) fn parse_connection(connection: &str) -> Result<String, CoreError> {
    let parsed = Url::parse(connection).map_err(|e| {
        CoreError::InvalidTxData(format!(
            "invalid connection `{connection}`: expected HTTP(S) URL ({e})"
        ))
    })?;
    match parsed.scheme() {
        "http" | "https" => Ok(connection.to_owned()),
        other => Err(CoreError::InvalidTxData(format!(
            "unsupported connection scheme `{other}`; expected http or https"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn parse_connection_http_url() {
        let parsed = parse_connection("http://127.0.0.1:8332").expect("should parse");
        assert_eq!(parsed, "http://127.0.0.1:8332");
    }

    #[test]
    fn parse_connection_invalid_scheme() {
        let err = parse_connection("ftp://example.com").expect_err("must reject ftp");
        assert!(err.to_string().contains("unsupported connection scheme"));
    }

    #[test]
    fn resolve_auth_rejects_partial_credentials() {
        let err = resolve_auth(Some("user"), None, None).expect_err("must reject partial auth");
        assert!(err.to_string().contains("must be set together"));
    }

    #[test]
    fn resolve_auth_accepts_user_and_pass() {
        let auth = resolve_auth(Some("alice"), Some("secret"), None).expect("auth must parse");
        assert_eq!(auth, Some(("alice".to_owned(), "secret".to_owned())));
    }

    #[test]
    fn resolve_auth_reads_cookie_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time must be after unix epoch")
            .as_nanos();
        let cookie_path = std::env::temp_dir().join(format!("cory-core-cookie-{unique}.txt"));
        fs::write(&cookie_path, "__cookie__:token\n").expect("cookie file must be writable");

        let auth = resolve_auth(None, None, Some(&cookie_path)).expect("cookie must parse");
        assert_eq!(auth, Some(("__cookie__".to_owned(), "token".to_owned())));

        let _ = fs::remove_file(cookie_path);
    }
}
