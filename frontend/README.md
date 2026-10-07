# LPS – Projects Utility — frontend

React Router (framework mode) client for LPS – Projects Utility by Plenum Tech. Based on the React Router template:

A modern, production-ready template for building full-stack React applications using React Router.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/remix-run/react-router-templates/tree/main/default)

## Features

- 📄 Single-page app (static build served by the API)
- ⚡️ Hot Module Replacement (HMR)
- 📦 Asset bundling and optimization
- 🔄 Data loading and mutations
- 🔒 TypeScript by default
- 🎉 TailwindCSS for styling
- 📖 [React Router docs](https://reactrouter.com/)

## Getting Started

### Installation

Install the dependencies:

```bash
bun install
```

### Development

Start the development server with HMR:

```bash
bun run dev
```

Your application will be available at `http://localhost:5173`.

## Building for Production

Create a production build:

```bash
bun run build
```

## Deployment

The app is built in **SPA mode** (`ssr: false`): `bun run build` writes static
files to `build/client`, which the Express backend serves from the same origin.
Production ships as one container (API + UI) built from the repository root —
see [`DEPLOY-AZURE.md`](../DEPLOY-AZURE.md). Build with `VITE_API_URL=/api`.

## Styling

This template comes with [Tailwind CSS](https://tailwindcss.com/) already configured for a simple default starting experience. You can use whatever CSS framework you prefer.

---

Built with ❤️ using React Router.
