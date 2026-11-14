/**
 * Global declarations for the tool-doctor client bundle.
 *
 * - CSS module imports are typed in `css-modules.d.ts`.
 * - React 18 types come from @types/react (dev dependency); with the automatic
 *   JSX runtime (`jsx: react-jsx`) component files need no React import, only
 *   type-only named imports. No extra global React declarations are required.
 *
 * The esbuild build currently injects no globals; if a future build adds one
 * (for example a version `define`), declare it here so strict mode can see it:
 *
 *   declare const __DSH_TOOL_DOCTOR_VERSION__: string;
 */
