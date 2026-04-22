# Interactive Tavern Demo

### Try it out @ https://spark-physics.netlify.app

![Tavern Demo](tavern.gif)

A showcase of [**Spark**](https://sparkjs.dev/) Gaussian splats, **Rapier Physics**, and **Three.js**, now hosted inside a minimal Next.js App Router shell.

## Features

- Gaussian splat rendering with a collision-mesh fallback
- Rapier-powered physics for player movement and projectiles
- Animated characters with bone-level collision detection
- Spatial audio with distance-based volume and bounce-driven pitch
- Pointer-lock first-person controls and an in-scene grab system
- Debug mode for toggling the collision mesh and bone collider overlays

## Controls

- `Click`: Enter first-person mode / shoot projectiles
- `WASD`: Move around the tavern
- `R` / `F`: Fly up and down
- `Space`: Jump
- `M`: Toggle debug mode
- `P`: Log the player transform to the console

## Getting started

```bash
npm install
npm run dev
```

The Next.js dev server runs on [http://localhost:3000](http://localhost:3000) by default.

## Production build

```bash
npm run build
npm run preview
```

`npm run build` creates a static export in `out/`, which can be deployed to static hosting as long as the required COOP and COEP headers are preserved.
