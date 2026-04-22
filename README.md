# Haunt Game

An atmospheric first-person investigation slice built with Next.js, Three.js, Spark splats, and Rapier physics.

![Tavern Demo](tavern.gif)

A single NPC, `mob_boss_sitting`, guards a secret. Walk up, press `E`, and use Grok voice chat to try to pry the truth out of them.

## Features

- Gaussian splat rendering with a collision-mesh fallback
- Rapier-powered first-person movement
- One focused NPC interaction loop
- Grok realtime voice chat over xAI ephemeral tokens
- On-screen transcript, dialogue states, and objective tracking
- Runtime-ready Next.js deployment for Vercel

## Controls

- `Click`: Enter first-person mode
- `WASD`: Move around the tavern
- `R` / `F`: Fly up and down
- `Space`: Jump
- `E`: Talk to the mob boss when prompted
- `Esc`: Leave the conversation overlay

## Getting started

```bash
npm install
echo "XAI_API_KEY=your_key_here" > .env.local
npm run dev
```

The Next.js dev server runs on [http://localhost:3000](http://localhost:3000) by default.

## Production build

```bash
npm run build
npm start
```

Deploy this app to Vercel or another runtime-capable Next.js host. The app uses a server route to mint ephemeral xAI tokens, so it is no longer a static export.
