"""PIN-authorization crypto for Aeris ATSP remote operations.

Replicated from the decompiled app:
- com/aeris/atsp/service/extras/GenerateClientNonce.java
- com/aeris/atsp/service/extras/GenerateHash.java
- com/aeris/atsp/service/extras/Utility.java (hmacSha256)

The hash algorithm is byte-for-byte identical to the EU integration's
_compute_pin_hash, which is known-good — only the surrounding endpoints/field
names differ.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os


def generate_client_nonce() -> str:
    """Opaque random nonce, base64 of 32 bytes.

    The app produces this via AES-CBC of a random string, but the ciphertext is
    never decrypted server-side — it's just an opaque blob the server stores and
    feeds back into the HMAC. Plain random bytes are equivalent (this is exactly
    what the working EU integration does).
    """
    return base64.b64encode(os.urandom(32)).decode("ascii")


def compute_pin_hash(client_nonce_b64: str, server_nonce_b64: str, pin: str) -> str:
    """HMAC-SHA256(key = clientNonceBytes + b':' + serverNonceBytes, msg = pin),
    then XOR-fold the 32-byte digest to 16 bytes, then base64.

    Matches GenerateHash.generateHash() exactly.
    """
    client_bytes = base64.b64decode(client_nonce_b64)
    server_bytes = base64.b64decode(server_nonce_b64)
    key = client_bytes + b":" + server_bytes
    digest = hmac.new(key, pin.encode("utf-8"), hashlib.sha256).digest()  # 32 bytes
    folded = bytes(digest[i] ^ digest[i + 16] for i in range(16))
    return base64.b64encode(folded).decode("ascii")
