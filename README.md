# store-backend

Public deploy source for the MakretDZ backend (Express + Postgres/Neon), used by
Render. It is a squashed snapshot of the private `anes255/test` repo — no commit
history, so no credential that was ever committed there can be recovered here.

**Nothing secret belongs in this repository.** All configuration comes from
environment variables set on the host (Render → Environment):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres/Neon connection string |
| `JWT_SECRET` | signing key for auth tokens |
| `PLATFORM_ADMIN_PHONE` | super-admin login phone |

Run locally with `npm install && npm start`.
