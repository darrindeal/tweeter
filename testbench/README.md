# Testbench Vite Project

This directory contains a small [Vite](https://vitejs.dev/) application used to
interact with the Pusher compatible Cloudflare Worker from the root project.

## Available Scripts

- `npm run dev` – Start the development server.
- `npm run build` – Build the project for production.
- `npm run preview` – Preview the production build.

When the dev server starts the app will attempt to connect to the Worker running
on `localhost:8787` using the default credentials from `wrangler.jsonc`. A
simple UI lets you send messages to `test-channel` and shows received events in
the log panel.
