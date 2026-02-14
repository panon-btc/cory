use eyre::{Context, Result};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

pub const JWT_COOKIE_NAME: &str = "cory_refresh_token";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenType {
    Access,
    Refresh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Expiration time (seconds since UNIX epoch)
    #[serde(rename = "exp")]
    pub expiry_time: u64,
    /// Issued at time (seconds since UNIX epoch)
    #[serde(rename = "iat")]
    pub issued_at_time: u64,
    /// Session identifier for tracking unique connections
    pub session_id: String,
    /// Token type (access or refresh)
    pub token_type: TokenType,
}

pub struct JwtManager {
    secret: Vec<u8>,
    access_token_lifetime: Duration,
    refresh_token_lifetime: Duration,
}

impl JwtManager {
    /// Creates a new JWT manager with the provided secret key.
    pub fn new(secret: Vec<u8>) -> Self {
        Self {
            secret,
            access_token_lifetime: Duration::from_secs(15 * 60), // 15 minutes
            refresh_token_lifetime: Duration::from_secs(7 * 24 * 60 * 60), // 7 days
        }
    }

    /// Generates a new access token for a session (15 minute expiry).
    pub fn generate_access_token(&self, session_id: String) -> Result<String> {
        self.generate_token_with_lifetime(session_id, TokenType::Access, self.access_token_lifetime)
    }

    /// Generates a new refresh token for a session (7 day expiry).
    pub fn generate_refresh_token(&self, session_id: String) -> Result<String> {
        self.generate_token_with_lifetime(
            session_id,
            TokenType::Refresh,
            self.refresh_token_lifetime,
        )
    }

    /// Generates a JWT token with the specified lifetime.
    fn generate_token_with_lifetime(
        &self,
        session_id: String,
        token_type: TokenType,
        lifetime: Duration,
    ) -> Result<String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("get current time")?
            .as_secs();

        let claims = Claims {
            expiry_time: now + lifetime.as_secs(),
            issued_at_time: now,
            session_id,
            token_type,
        };

        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(&self.secret),
        )
        .context("encode JWT token")?;

        Ok(token)
    }

    /// Validates a JWT token and returns the claims if valid.
    pub fn validate_token(&self, token: &str) -> Result<Claims> {
        let token_data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.secret),
            &Validation::default(),
        )
        .context("decode and validate JWT token")?;

        Ok(token_data.claims)
    }
}

/// Generates a cryptographically secure random secret for JWT signing.
pub fn generate_jwt_secret() -> Vec<u8> {
    use rand::Rng;
    let mut secret = vec![0u8; 32];
    rand::thread_rng().fill(&mut secret[..]);
    secret
}

/// Axum middleware that automatically validates JWT access tokens from the Authorization header.
///
/// This middleware extracts the JWT access token from the Authorization header (Bearer scheme),
/// validates it, and attaches the validated claims as an extension to the request.
/// If validation fails, it returns a 401 Unauthorized.
///
/// Protected routes can access the claims via the `AuthenticatedUser` extractor.
pub async fn jwt_auth_middleware(
    jwt_manager: Arc<JwtManager>,
    mut request: Request,
    next: Next,
) -> Response {
    let uri = request.uri().to_string();
    tracing::debug!("[JWT] Middleware invoked for: {}", uri);

    // Attempt to extract the JWT token from the Authorization header.
    let token = match request.headers().get(axum::http::header::AUTHORIZATION) {
        Some(header_value) => match header_value.to_str() {
            Ok(header_str) => {
                if let Some(token) = header_str.strip_prefix("Bearer ") {
                    token.to_string()
                } else {
                    tracing::warn!(
                        "[JWT] Invalid Authorization header format for route: {}",
                        uri
                    );
                    return (
                        StatusCode::UNAUTHORIZED,
                        "Invalid Authorization header format",
                    )
                        .into_response();
                }
            }
            Err(_) => {
                tracing::warn!(
                    "[JWT] Invalid Authorization header encoding for route: {}",
                    uri
                );
                return (
                    StatusCode::UNAUTHORIZED,
                    "Invalid Authorization header encoding",
                )
                    .into_response();
            }
        },
        None => {
            tracing::warn!("[JWT] Missing Authorization header for route: {}", uri);
            return (StatusCode::UNAUTHORIZED, "Missing Authorization header").into_response();
        }
    };

    // Validate the JWT token.
    match jwt_manager.validate_token(&token) {
        Ok(claims) => {
            if claims.token_type != TokenType::Access {
                tracing::warn!(
                    "[JWT] Non-access token used for API access on route: {}",
                    uri
                );
                return (StatusCode::UNAUTHORIZED, "Invalid token type").into_response();
            }

            tracing::debug!(
                "[JWT] Access token valid for session: {} on route: {}",
                claims.session_id,
                uri
            );
            request.extensions_mut().insert(claims);
            next.run(request).await
        }
        Err(e) => {
            tracing::warn!("[JWT] Token invalid for route: {} — {}", uri, e);
            (StatusCode::UNAUTHORIZED, "Invalid or expired access token").into_response()
        }
    }
}

/// Extractor for validated JWT claims from request extensions.
#[derive(Clone)]
#[allow(dead_code)] // Claims field used for future session introspection
pub struct AuthenticatedUser(pub Claims);

impl<S> axum::extract::FromRequestParts<S> for AuthenticatedUser
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Claims>()
            .cloned()
            .map(AuthenticatedUser)
            .ok_or((
                StatusCode::UNAUTHORIZED,
                "Missing authentication - JWT middleware not applied",
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_access_token_generation_and_validation() {
        let manager = JwtManager::new(generate_jwt_secret());
        let session_id = "test_session".to_string();

        let token = manager.generate_access_token(session_id.clone()).unwrap();
        let claims = manager.validate_token(&token).unwrap();

        assert_eq!(claims.session_id, session_id);
        assert_eq!(claims.token_type, TokenType::Access);
        assert!(claims.expiry_time > claims.issued_at_time);
    }

    #[test]
    fn test_refresh_token_generation_and_validation() {
        let manager = JwtManager::new(generate_jwt_secret());
        let session_id = "test_session".to_string();

        let token = manager.generate_refresh_token(session_id.clone()).unwrap();
        let claims = manager.validate_token(&token).unwrap();

        assert_eq!(claims.session_id, session_id);
        assert_eq!(claims.token_type, TokenType::Refresh);
        assert!(claims.expiry_time > claims.issued_at_time);
    }

    #[test]
    fn test_invalid_token_rejected() {
        let manager = JwtManager::new(generate_jwt_secret());
        let result = manager.validate_token("invalid_token");

        assert!(result.is_err());
    }

    #[test]
    fn test_wrong_secret_rejected() {
        let manager1 = JwtManager::new(generate_jwt_secret());
        let manager2 = JwtManager::new(generate_jwt_secret());

        let token = manager1
            .generate_access_token("session_test".to_string())
            .unwrap();
        let result = manager2.validate_token(&token);

        assert!(result.is_err());
    }
}
