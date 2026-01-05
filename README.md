
# Zero-Knowledge Encrypted Semantic Search

A full-stack system that performs semantic image search on a server without ever decrypting the data. It utilizes client-side AI for embedding generation and Homomorphic Encryption (CKKS) to allow the backend to calculate vector similarity scores while remaining blind to the actual content.

The server infrastructure never possesses decryption keys, raw images, or plaintext search queries.

## Key Features

* **Zero-Knowledge Architecture:** Data is encrypted in the browser before transmission. The server operates exclusively on ciphertext.
* **Client-Side AI:** Utilizes Transformers.js to run the quantized CLIP model entirely within the user's browser for local embedding generation.
* **Homomorphic Encryption:** Implements the CKKS scheme via a custom C++/WASM engine, enabling mathematical operations on encrypted vectors.
* **Hybrid Storage:** Offloads heavy encrypted assets to Cloudflare R2 while keeping search indices in MongoDB.

## Tech Stack

* **Frontend:** React, Vite
* **Backend:** Node.js, Fastify
* **AI/ML:** Transformers.js (CLIP ViT-Base-Patch32 via ONNX)
* **Cryptography:** Microsoft SEAL (C++ compiled to WASM), CryptoJS
* **Database:** MongoDB Atlas
* **Object Storage:** Cloudflare R2 (S3-compatible)

## Prerequisites

Before running, ensure you have:
* Node.js (v18 or higher)
* A MongoDB connection URI
* A Cloudflare R2 bucket with an Access Key ID and Secret Access Key

## Installation

### 1. Backend Setup

Navigate to the server directory, install dependencies, and configure environments.

```bash
cd server
npm install

```

Create a `.env` file in the `server/` root:

```env
PORT=3000
JWT_SECRET=your-secure-random-secret
MONGO_URI=mongodb+srv://your-mongo-uri
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_BUCKET_NAME=your-bucket-name
R2_ACCESS_KEY=your-access-key
R2_SECRET_KEY=your-secret-key

```

### 2. Frontend Setup

Navigate to the client directory and install dependencies.

```bash
cd client
npm install

```

## Running the Application

Start the backend server (runs on port 3000):

```bash
cd server
node server.js

```

Start the frontend development server (runs on port 5173):

```bash
cd client
npm run dev

```

Access the application at `http://localhost:5173`.

## Usage Workflow

1. **Register:** Create an account. This generates AES and CKKS keys locally in your browser.
2. **Upload:** Select an image. It is processed by the local AI, encrypted, and uploaded.
3. **Search:** Enter a text query. The query is vectorised, encrypted, and sent to the server for blind computation against stored records.

```

```
