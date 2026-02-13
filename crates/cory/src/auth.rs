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
use tower_cookies::Cookies;

pub const JWT_COOKIE_NAME: &str = "cory_jwt_token";

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
}

pub struct JwtManager {
    secret: Vec<u8>,
    token_lifetime: Duration,
}

impl JwtManager {
    /// Creates a new JWT manager with the provided secret key.
    pub fn new(secret: Vec<u8>) -> Self {
        Self {
            secret,
            token_lifetime: Duration::from_secs(24 * 60 * 60), // 24 hours
        }
    }

    /// Generates a new JWT token for a session.
    pub fn generate_token(&self, session_id: String) -> Result<String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("get current time")?
            .as_secs();

        let claims = Claims {
            expiry_time: now + self.token_lifetime.as_secs(),
            issued_at_time: now,
            session_id,
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

/// Axum middleware that automatically validates JWT tokens from cookies.
///
/// This middleware extracts the JWT token from the request cookies,
/// validates it, and attaches the validated claims as an extension
/// to the request. If validation fails, it returns a 401 Unauthorized.
///
/// Protected routes can access the claims via the `AuthenticatedUser` extractor.
pub async fn jwt_auth_middleware(
    jwt_manager: Arc<JwtManager>,
    cookies: Cookies,
    mut request: Request,
    next: Next,
) -> Response {
    let uri = request.uri().to_string();
    tracing::info!("[JWT] Middleware invoked for: {}", uri);

    // Attempt to extract the JWT token from the cookie
    let token = match cookies.get(JWT_COOKIE_NAME) {
        Some(cookie) => {
            let token = cookie.value().to_string();
            tracing::info!(
                "[JWT] Cookie '{}' found, token length: {}",
                JWT_COOKIE_NAME,
                token.len()
            );
            token
        }
        None => {
            tracing::warn!(
                "[JWT] Cookie '{}' NOT FOUND for route: {}",
                JWT_COOKIE_NAME,
                uri
            );
            return (StatusCode::UNAUTHORIZED, "Missing authentication cookie").into_response();
        }
    };

    // Validate the JWT token
    match jwt_manager.validate_token(&token) {
        Ok(claims) => {
            tracing::info!(
                "[JWT] Token VALID for session: {} on route: {}",
                claims.session_id,
                uri
            );
            request.extensions_mut().insert(claims);
            next.run(request).await
        }
        Err(e) => {
            tracing::warn!("[JWT] Token INVALID for route: {} - Error: {}", uri, e);
            (StatusCode::UNAUTHORIZED, "Invalid or expired JWT token").into_response()
        }
    }
}

/// Extractor for validated JWT claims from request extensions.
///
/// Use this in protected route handlers to access the authenticated
/// session information without manually validating tokens.
#[derive(Clone)]
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
    fn test_token_generation_and_validation() {
        let manager = JwtManager::new(generate_jwt_secret());
        let session_id = "test_session".to_string();

        let token = manager.generate_token(session_id.clone()).unwrap();
        let claims = manager.validate_token(&token).unwrap();

        assert_eq!(claims.session_id, session_id);
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

        let token = manager1.generate_token("session_test".to_string()).unwrap();
        let result = manager2.validate_token(&token);

        assert!(result.is_err());
    }
}
