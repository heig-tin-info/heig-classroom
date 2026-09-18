import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApiError } from "./api";
import App from "./App";
import { ConfirmProvider } from "./confirm";
import { HelpProvider } from "./help";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./notify";
import { applyTheme, initialTheme } from "./theme";
import "./style.css";

async function boot() {
  // Design work without a backend: `pnpm dev:mock` serves fake data from the
  // browser. The flag is static, so production builds drop this branch.
  if (import.meta.env.VITE_MOCK === "1") await import("./mock");

  applyTheme(initialTheme());

  // One retry, and none on a 4xx: the default three retries kept an error
  // state seven seconds away, which reads as a hang rather than a failure.
  // A 4xx is an answer, not a hiccup, so asking again cannot change it.
  // `useMe` keeps its own `retry: false` (a 401 is the signed-out state).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
      },
    },
  });

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ToastProvider>
            <ConfirmProvider>
              <HelpProvider>
                <App />
              </HelpProvider>
            </ConfirmProvider>
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot();
