# Clerk

- `CLERK_SECRET_KEY` — one per environment

Clerk gives every application two **instances**, development and production,
each with its own secret key: `sk_test_…` reaches only the development
instance and `sk_live_…` only production. So this field is per environment,
and `kx creds --guide` asks for both.

The key cannot reach another instance, which is why doctor has no separate
account check: a key that answers is a key for the instance it was made in.

## Keys

1. [dashboard.clerk.com](https://dashboard.clerk.com) → the application →
   **Configure** → **API keys**.
2. The instance selector is at the top of the dashboard. **Development**
   first: copy **Secret key** (`sk_test_…`).
3. Switch to **Production** and copy that instance's secret key
   (`sk_live_…`). If production does not exist yet, skip it and come back:
   `kx creds --guide` picks up where the item is.

The **publishable key** (`pk_…`) is not a secret. The app declares it in its
own `kx.env.json` with `--value`, one per environment.

## Putting it in

```bash
kx creds --project <project> --guide
kx doctor --project <project>
kx doctor --project <project> --env production
```

`401` → wrong key, or a test key used against production. `403` → the key is
fine and the instance is suspended or the endpoint is off for its plan.

## Using it

The Clerk SDKs read `CLERK_SECRET_KEY` by default, and `kx exec --env
production` injects the live one. If the repository still declares the
variable in `kx.env.json`, drop that line and sync: the value moves here.
