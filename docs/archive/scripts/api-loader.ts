/**
 * Version-aware loader for @actual-app/api.
 *
 * Selects which installed copy of the API to use based on the
 * `ACTUAL_API_VERSION` env var. Each candidate version is installed as an
 * npm alias in package.json (e.g. `@actual-app/api-26-4-0`); the loader maps
 * `26.4.0` -> `@actual-app/api-26-4-0`. If the env var is unset, the default
 * `@actual-app/api` dependency is used.
 *
 * Adding a new pin: add another alias to package.json, run `npm install`.
 *
 * Async because tsx runs us as CommonJS in this project, and `import()` is
 * the only way to take a runtime-computed package name. Callers `await
 * loadApi()` inside their existing async setup.
 */
type ActualApi = typeof import('@actual-app/api');

const pin = process.env.ACTUAL_API_VERSION;
export const apiPackage = pin
  ? `@actual-app/api-${pin.replaceAll('.', '-')}`
  : '@actual-app/api';

let cached: ActualApi | undefined;

export async function loadApi(): Promise<ActualApi> {
  if (!cached) {
    cached = (await import(apiPackage)) as ActualApi;
  }
  return cached;
}
