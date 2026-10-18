# schemas

`pnpm schemas` writes each app's log field schema here as `<app>.hyde-json.json`, downloaded from `prisma/hyde-json.json` on the app repo's `main` branch. The files are not committed: the app repos own them (D23). The server refuses to start while one is missing.
