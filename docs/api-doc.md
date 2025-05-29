# 📚 EtherDoc API Documentation

## 🌟 Overview

EtherDoc is a blockchain-based document management system that uses Ethereum wallet signatures for authentication. The API provides endpoints for user authentication and document management through IPFS via Pinata.

## 🔐 Authentication Flow

EtherDoc uses a **signature-based authentication** system:

1. **Get Nonce**: First, request a unique nonce from the server
2. **Sign Message**: Sign the message containing the nonce with your Ethereum wallet
3. **Login**: Submit the signature to receive a JWT token
4. **Access**: Use the JWT token for authenticated requests

## 🚀 Base URL

```
http://localhost:3000
```

---

## 📋 Endpoints

### 🏠 Health Check

#### `GET /`

Simple health check endpoint.

**Response:**
```json
"Hello World!"
```

---

### 🔑 Authentication

#### `GET /auth/nonce`

Get a unique nonce for message signing.

**Headers:**
```
Content-Type: application/json
```

**Response:**
```json
{
  "messageObject": {
    "address": "0x1234567890123456789012345678901234567890",
    "message": "auth-login",
    "nonce": "550e8400-e29b-41d4-a716-446655440000"
  },
  "messageString": "{\"address\":\"0x1234567890123456789012345678901234567890\",\"message\":\"auth-login\",\"nonce\":\"550e8400-e29b-41d4-a716-446655440000\"}"
}
```

**Error Responses:**
- `500 Internal Server Error`: Server configuration error

---

#### `POST /auth/login`

Authenticate with Ethereum signature.

**Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "signature": "0x1234567890abcdef..."
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response Headers:**
```
Set-Cookie: etherdoc-auth=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Error Responses:**
- `400 Bad Request`: Invalid signature format
- `401 Unauthorized`: Invalid signature or expired nonce
- `500 Internal Server Error`: Server configuration error

---

### 📄 Documents

#### `GET /documents`

Get list of files from specified network.

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <jwt_token>
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `network` | string | ✅ | Network type: `public` or `private` |

**Example Request:**
```
GET /documents?network=public
```

**Response:**
```json
{
  "files": [
    {
      "id": "QmHash123...",
      "name": "document1.pdf",
      "size": 1024,
      "timestamp": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**Error Responses:**
- `400 Bad Request`: Invalid network parameter
- `401 Unauthorized`: Missing or invalid JWT token
- `500 Internal Server Error`: Pinata API error or server configuration issue

---

## 🛡️ Authentication Example

### Step 1: Get Nonce

```bash
curl -X GET http://localhost:3000/auth/nonce \
  -H "Content-Type: application/json"
```

### Step 2: Sign Message

Use the `messageString` from the response to sign with your Ethereum wallet:

```javascript
// Using ethers.js
import { ethers } from 'ethers';

const wallet = new ethers.Wallet('your-private-key');
const signature = await wallet.signMessage(messageString);
```

### Step 3: Login

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "signature": "0x1234567890abcdef..."
  }'
```

### Step 4: Access Protected Endpoints

```bash
curl -X GET "http://localhost:3000/documents?network=public" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json"
```

---

## ⚠️ Error Handling

All endpoints return standardized error responses:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request"
}
```

### Common HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | ✅ Success |
| `400` | ❌ Bad Request - Invalid input |
| `401` | 🔒 Unauthorized - Authentication required |
| `500` | 💥 Internal Server Error - Server issue |

---

## 🔧 Configuration

The following environment variables are required:

```env
# JWT Configuration
JWT_SECRET=your-jwt-secret
JWT_EXPIRES_IN=5m

# Admin Address
ADDRESS_ADMIN=0x1234567890123456789012345678901234567890

# Pinata Configuration
PINATA_API_URL=https://api.pinata.cloud
PINATA_JWT_TOKEN=your-pinata-jwt-token

# Server Configuration
PORT=3000
```

---

## 📝 Validation Rules

### Network Parameter
- Must be either `"public"` or `"private"`
- Case-sensitive
- Required for document endpoints

### Signature Format
- Must be a valid Ethereum signature (hex string starting with "0x")
- Must be generated from the exact `messageString` provided by the nonce endpoint

---

## 🎯 Best Practices

1. **Always get a fresh nonce** before each login attempt
2. **Store JWT tokens securely** (httpOnly cookies recommended)
3. **Handle token expiration** gracefully (default: 5 minutes)
4. **Validate network parameters** before making requests
5. **Implement proper error handling** for all API calls

---

## 🔗 Related Resources

- [Ethereum Signature Verification](https://docs.ethers.io/v5/api/utils/signing-key/)
- [JWT Token Handling](https://jwt.io/)
- [Pinata IPFS API](https://docs.pinata.cloud/)