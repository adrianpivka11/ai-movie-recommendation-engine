# Movie App

Full-stack movie recommendation app.

## Structure

- `frontend` - React TypeScript client built with Vite.
- `backend` - Express TypeScript API server.
- `database` - Python data pipeline, CSV files, and database preparation scripts.

## AWS migration

The planned asynchronous job API is documented in
[recommendation-jobs-api.md](docs/recommendation-jobs-api.md).
Its TypeScript contracts are in `backend/src/jobs/types.ts`; the current
synchronous Express endpoint remains active until the handlers and frontend
polling flow are implemented.

SAM infrastructure and Lambda container packaging are described in
[aws-sam.md](docs/aws-sam.md). These files do not deploy resources automatically;
the existing local/Render Express application remains unchanged.

## Local development

Install JavaScript dependencies:

```powershell
npm run install:all
```

Run frontend and backend together:

```powershell
npm run dev
```

Run only frontend:

```powershell
npm run dev:frontend
```

Run only backend:

```powershell
npm run dev:backend
```



MCP vs. Agentic version: 
How to quickly revert back to the old mode if MCP is causing problems:
in backend/src/app.ts or in the imported agent layer
import { movieChoiceAgentOldVersion as movieChoiceAgent } from "./agentOldVersion.js";
