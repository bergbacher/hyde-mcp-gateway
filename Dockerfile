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
# The tree includes apps.json, the app registry the server reads at startup
# (D38), and schemas/, not committed but for edge.hyde-json.json (D46): `pnpm schemas` (log field
# schemas) and `pnpm fetch:redacted-schemas` (redacted-schema.md) fill it from
# the app repos' main before the build (deploy.yml; README, First deploy). The
# server serves the registered apps whose files are present (D37); an app
# without them is refused at its tools. An image that could serve no app is
# useless, so the build stops unless at least one app in apps.json has its
# complete pair: schemas/<app>.hyde-json.json and schemas/<app>.redacted-schema.md.
COPY . .
RUN test -s apps.json || { echo "apps.json is missing: the server cannot start without its app registry" >&2; exit 1; }; \
    apps=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync("apps.json", "utf8")).apps).join(" "))') || { echo "apps.json is not a registry" >&2; exit 1; }; \
    ready=""; \
    for app in $apps; do \
      if test -s "schemas/$app.hyde-json.json" && test -s "schemas/$app.redacted-schema.md"; then ready="$ready $app"; \
      else echo "warning: $app is not configured: schemas/$app.hyde-json.json or schemas/$app.redacted-schema.md is missing" >&2; fi; \
    done; \
    test -n "$ready" || { echo "no app has both schema files: run pnpm schemas and pnpm fetch:redacted-schemas before docker build" >&2; exit 1; }; \
    echo "apps with schemas:$ready"
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

USER node
# src/config.ts reads PORT; infra/base.yaml `container.port` is the same.
ENV PORT=8080
EXPOSE 8080
# Node runs the TypeScript sources directly (type stripping); there is no build.
CMD ["node", "src/mcp/main.ts"]
