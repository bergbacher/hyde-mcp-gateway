# syntax=docker/dockerfile:1.7
#
# hyde-mcp-gateway's image. .github/workflows/deploy.yml builds it and pushes it to
# the registry infra/base.yaml names.
#
# --platform is pinned: Scaleway Serverless Containers run amd64 only and
# reject anything else at deploy time, which is what a default build on an
# Apple Silicon Mac produces.
FROM --platform=linux/amd64 node:24-slim
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

# The whole tree, not just package.json: a pnpm workspace (packages/) needs
# its members' manifests to install from the root lockfile. .dockerignore
# keeps node_modules, apply.env and .env* out of the context.
#
# The tree includes apps.json, the app registry the server reads at startup,
# an operator file that is not committed (D38; the deploy workflow writes it
# from a repository secret). It holds no app schema: the server fetches each
# app's log field schema and redacted schema from its repo at runtime and
# refreshes them on a schedule (D58, src/schema-store.ts), so a schema change
# needs no image. .dockerignore keeps schemas/ out but for the committed
# edge.hyde-json.json (D46), so files a local `pnpm schemas` wrote cannot
# reach the image.
COPY . .
RUN test -s apps.json || { echo "apps.json is missing: copy apps.example.json to apps.json and register your apps; the server cannot start without its app registry" >&2; exit 1; }; \
    apps=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync("apps.json", "utf8")).apps).join(" "))') || { echo "apps.json is not a registry" >&2; exit 1; }; \
    echo "apps: $apps"
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

USER node
# src/config.ts reads PORT; infra/base.yaml `container.port` is the same.
ENV PORT=8080
EXPOSE 8080
# Node runs the TypeScript sources directly (type stripping); there is no build.
CMD ["node", "src/mcp/main.ts"]
