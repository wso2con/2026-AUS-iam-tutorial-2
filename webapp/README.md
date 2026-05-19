# Wayfinder Enterprise

A Next.js B2B sample app demonstrating Asgardeo IAM integration. It includes organization onboarding, role-based access control, travel policy management, flight booking, and an optional AI agent with Asgardeo agent authentication.

## Prerequisites

- Node.js 22 or later
- An [Asgardeo](https://wso2.com/asgardeo/) account with a root organization

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy the sample environment file:

```bash
cp .env.example .env.local
```

Then open `.env.local` and fill in the values for your Asgardeo workspace:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_ASGARDEO_BASE_URL` | Your Asgardeo API base URL — `https://api.asgardeo.io/t/<org-name>` |
| `NEXT_PUBLIC_ASGARDEO_CLIENT_ID` | Client ID of your registered application |
| `ASGARDEO_CLIENT_SECRET` | Client secret — keep this server-side only, never use the `NEXT_PUBLIC_` prefix |
| `ASGARDEO_PARENT_ORGANIZATION_ID` | The UUID of your root Asgardeo organization |
| `ASGARDEO_APP_ID` | The application ID from the Asgardeo Console |
| `ASGARDEO_APP_DISPLAY_NAME` | The display name shown to users during onboarding |

The `NEXT_PUBLIC_ASGARDEO_SCOPES` and `ASGARDEO_ROOT_SCOPES` values in `.env.example` are pre-configured with the scopes required by the app. Update them only if you change the feature set.

Optionally, set `DB_PATH` to a custom SQLite file location (defaults to `data/app.db`).

### 3. Start the development server

```bash
npm run dev
```

Or, for a faster production build:

```bash
npm run build && npm run start
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Seed the flight catalog

The app uses a SQLite database for flight data. After the server is running, seed it with the initial flight catalog:

```bash
npm run seed:flights
```

This populates the database with flights across Economy, Premium Economy, Business, and First Class cabins. Flights are shared across all organizations — only bookings are org-scoped.

To reset and re-seed (e.g. if you want a clean slate):

```bash
npm run seed:flights -- --force
```

> The seed script is safe to run multiple times without `--force` — it exits early if data already exists.

### Resetting the database

To fully delete the database and its data folder, run:

```bash
npm run db:drop
```

The script reads `DB_PATH` from your environment (same as the app). If `DB_PATH` is not set, it removes the entire `data/` folder. If `DB_PATH` points to a custom location, only that file is deleted. After dropping, re-run `npm run seed:flights` to recreate the database.
