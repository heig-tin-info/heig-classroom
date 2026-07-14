import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { HelpProvider } from "./help";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./notify";
import { applyTheme, applyUiTheme, initialTheme, initialUiTheme } from "./theme";
import "./style.css";

applyTheme(initialTheme());
applyUiTheme(initialUiTheme());

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <HelpProvider>
            <App />
          </HelpProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);
