# Deploying to Vercel

This project now relies on Next.js server routes for xAI ephemeral token minting
and leaderboard reads/writes, so it should be deployed to a runtime-capable
host.

## Prerequisites

1. Make sure your code is pushed to a Git repository (GitHub, GitLab, or Bitbucket)
2. Have a Vercel account
3. Create an xAI API key and save it as `XAI_API_KEY`

## Deployment Steps

### Option 1: Deploy via Vercel UI

1. **Go to Vercel Dashboard**
   - Visit [vercel.com](https://vercel.com) and sign in
   - Click "Add New..." → "Project"

2. **Connect Your Repository**
   - Choose your Git provider (GitHub, GitLab, etc.)
   - Select your repository containing this project

3. **Configure Environment Variables**
   - Add `XAI_API_KEY` in the project settings before the first production deploy

4. **Deploy**
   - Vercel will detect Next.js automatically
   - The default build command `next build` is sufficient

### Option 2: Deploy via Vercel CLI

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel**
   ```bash
   vercel login
   ```

3. **Deploy**
   ```bash
   vercel --prod
   ```

## Important Notes

- Set `XAI_API_KEY` in every environment that needs voice chat
- COOP and COEP headers are configured in `next.config.mjs` for SharedArrayBuffer support
- WASM assets are explicitly served with the correct MIME type
- The browser authenticates to xAI using ephemeral tokens only; the API key stays server-side
- The current leaderboard uses a local SQLite file at `data/leaderboard.sqlite`,
  so it only persists correctly on a single long-lived host. It is not a
  durable production choice for ephemeral serverless filesystems.

## Troubleshooting

If you encounter issues:

1. **Check Vercel function logs** for `/api/grok/session` or `/api/grok/briefing`
2. **Verify `XAI_API_KEY`** is present in the deployment environment
3. **Confirm cross-origin isolation headers** are present in the deployed response
4. **Test locally** with `npm run dev` before deploying

## File Size Considerations

Your project includes large assets:
- `elegant_library_with_fireplace_2m.spz`
- `elegant_library_with_fireplace_collider.glb`
- `mob_boss_sitting.fbx`

These assets are large enough that the first load may take a moment. Subsequent requests should be cached by the hosting edge.
