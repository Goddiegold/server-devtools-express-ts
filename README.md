# ServerDevTools Express Smoke Test

Minimal Express consumer app for exercising the installed `server-devtools` package with:

- HTTP request and error capture
- PostgreSQL and MySQL2 database spans
- Mongoose and MongoDB spans
- Outbound `fetch()` capture
- Sensitive-data encryption
- Mock current-user metadata

## Setup

Create `.env` in this directory:

```env
MONGODB_URI=mongodb://localhost:27017
SERVER_DEVTOOLS_ENCRYPTION_KEY=<32-byte-base64-key>
```

Generate a key with:

```sh
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Install dependencies:

```sh
npm install
```

## Run

The app uses the existing ServerDevTools preload:

```sh
npm start
```

Development watch mode:

```sh
npm run start:dev
```

The app listens on `http://localhost:4000`.

## Routes

- `GET /hello`
- `POST /users`
- `GET /slow`
- `GET /not-found`
- `GET /external`
- `GET /mongo-test`
- `GET /sensitive-test`
- `GET /error`
- `GET /_devtools`

Example:

```sh
curl http://localhost:4000/hello
curl http://localhost:4000/users
curl http://localhost:4000/postgres-users
curl http://localhost:4000/mysql-users
curl http://localhost:4000/mongo-test
curl http://localhost:4000/sensitive-test
curl http://localhost:4000/error
```
