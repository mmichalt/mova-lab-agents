# mova-lab-agents

An independent AI-assisted content-generation service for Mova-Lab, a Ukrainian
speech-therapy application. The project also serves as a practical introduction
to agent orchestration using explicit Node.js, TypeScript, and Express functions.

Requires Node.js 24.12 or later. Development and tests run TypeScript sources
directly; production runs the compiled JavaScript in `dist/`. Constructing the
Express app (`createApp`) does not open a network port; only `src/server.ts`
listens.

## Commands

```sh
npm install
npm run dev         # native TypeScript: node src/server.ts
npm run typecheck   # tsc --noEmit
npm test            # node:test tests/**/*.test.ts
npm run build       # tsc -p tsconfig.build.json
npm start           # node dist/server.js
```

`PORT` defaults to `3000`. Ordinary automated tests do not need GPU, models,
Ollama, or cloud credentials.

## Planning documents

- [Architecture and learning plan](docs/architecture-plan.md)
- [Implementation backlog](docs/backlog.md)
