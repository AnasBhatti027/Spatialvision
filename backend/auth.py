"""Accounts for the phone app: sign up, log in, and username suggestions.

Users are stored in a local SQLite file (spatialvision.db, ignored by git).
Passwords are never stored as plain text: each one is hashed with PBKDF2
and a random salt, using only Python's built-in libraries.
"""
import hashlib
import hmac
import re
import secrets
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

DB_PATH = Path(__file__).parent / "spatialvision.db"
USER_RE = re.compile(r"^[a-z0-9_]{3,20}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
HASH_ROUNDS = 200_000

router = APIRouter(prefix="/auth", tags=["auth"])


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                username TEXT UNIQUE NOT NULL,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )"""
        )


def hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, HASH_ROUNDS).hex()


def new_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    return token


def user_from_token(authorization: str) -> sqlite3.Row:
    """Finds the logged-in user from an 'Authorization: Bearer <token>' header."""
    token = authorization.removeprefix("Bearer ").strip()
    with db() as conn:
        row = conn.execute(
            "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?",
            (token,),
        ).fetchone()
    if row is None:
        raise HTTPException(401, "Your session has ended. Please log in again.")
    return row


class SignupIn(BaseModel):
    email: str
    username: str
    password: str


class LoginIn(BaseModel):
    email: str
    password: str


@router.get("/usernames/available")
def usernames_available(names: str = ""):
    wanted = [n for n in names.split(",") if USER_RE.match(n)][:10]
    if not wanted:
        return {"available": []}
    with db() as conn:
        marks = ",".join("?" * len(wanted))
        taken = {r["username"] for r in conn.execute(
            f"SELECT username FROM users WHERE username IN ({marks})", wanted)}
    return {"available": [n for n in wanted if n not in taken]}


@router.post("/signup")
def signup(body: SignupIn):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address.")
    if not USER_RE.match(body.username):
        raise HTTPException(400, "Username: 3 to 20 characters, lowercase letters, numbers or underscore.")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters.")
    salt = secrets.token_bytes(16)
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "An account with this email already exists. Try logging in.")
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (body.username,)).fetchone():
            raise HTTPException(409, "That username is taken. Pick another one.")
        cur = conn.execute(
            "INSERT INTO users (email, username, salt, password_hash) VALUES (?, ?, ?, ?)",
            (email, body.username, salt.hex(), hash_password(body.password, salt)),
        )
        token = new_session(conn, cur.lastrowid)
    return {"username": body.username, "token": token}


@router.post("/login")
def login(body: LoginIn):
    email = body.email.strip().lower()
    with db() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if row is None or not hmac.compare_digest(
            hash_password(body.password, bytes.fromhex(row["salt"])), row["password_hash"]
        ):
            raise HTTPException(401, "Wrong email or password.")
        token = new_session(conn, row["id"])
    return {"username": row["username"], "token": token}


@router.get("/me")
def me(authorization: str = Header("")):
    row = user_from_token(authorization)
    return {"username": row["username"], "email": row["email"]}


@router.post("/logout")
def logout(authorization: str = Header("")):
    token = authorization.removeprefix("Bearer ").strip()
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return {"ok": True}


init_db()
