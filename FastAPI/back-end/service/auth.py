import os
from datetime import datetime, timedelta, timezone

import bcrypt
from dotenv import load_dotenv
from fastapi import Depends, HTTPException, Query, WebSocket, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt

load_dotenv()

AUTH_USERNAME = os.environ["AUTH_USERNAME"]
AUTH_PASSWORD_HASH = os.environ["AUTH_PASSWORD_HASH"]
JWT_SECRET_KEY = os.environ["JWT_SECRET_KEY"]
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", 60 * 12))

# tokenUrl only matters for OpenAPI docs (the "Authorize" button) - actual
# token issuance is at POST /auth/token, see routers/Auth.py.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/token", auto_error=False)


def verify_credentials(username: str, password: str) -> bool:
    if username != AUTH_USERNAME:
        return False
    return bcrypt.checkpw(password.encode(), AUTH_PASSWORD_HASH.encode())


def create_access_token(username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    return jwt.encode({"sub": username, "exp": expire}, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    username = payload.get("sub")
    if username != AUTH_USERNAME:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return username


def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    token_qs: str | None = Query(default=None, alias="token"),
) -> str:
    """Dependency for HTTP routes - requires a valid `Authorization: Bearer
    <token>` header. Also accepts ?token=... as a fallback, since a plain
    `<a href>` download link (e.g. GET /captures/{id}/download) can't attach
    custom headers - only used where a route is meant to be link-navigable."""
    effective = token or token_qs
    if effective is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _decode_token(effective)


async def get_current_user_ws(websocket: WebSocket, token: str | None = Query(default=None)) -> str:
    """Dependency for WebSocket routes - browsers can't set custom headers on
    the native WebSocket handshake, so the token travels as a query param
    instead (?token=...). Closes the connection before accepting it if the
    token is missing/invalid, so no data ever reaches an unauthenticated client."""
    if token is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        return _decode_token(token)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        raise
