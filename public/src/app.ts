import { initNav, registerPageLoader, startInitialPage } from "./nav";
import { checkSession, initAuth } from "./pages/auth";
import { initCatalog, loadCatalogTab } from "./pages/catalog";
import { initChat, loadChat, loadEmbeddings, loadGenerate } from "./pages/chat";
import { connect, initDashboard, loadAppVersion, loadDashboard } from "./pages/dashboard";
import { initLiteLLM, loadLiteLLMStatus } from "./pages/litellm";
import { initModels, loadModels, loadRunning } from "./pages/models";
import { initModal } from "./ui/modal";

registerPageLoader("dashboard", loadDashboard);
registerPageLoader("models", loadModels);
registerPageLoader("running", loadRunning);
registerPageLoader("chat", loadChat);
registerPageLoader("generate", loadGenerate);
registerPageLoader("embeddings", loadEmbeddings);
registerPageLoader("catalog", loadCatalogTab);
registerPageLoader("litellm", loadLiteLLMStatus);

initNav();
initModal();
initAuth();
initDashboard();
initModels();
initChat();
initCatalog();
initLiteLLM();

startInitialPage();

(async () => {
  // Skip connect() when a master key is required and we're not authenticated
  // yet — otherwise the proxy's 401 gets swallowed and the header shows a
  // false "connected" status behind the login overlay. doLogin() calls
  // connect() itself once a session token is obtained.
  const authed = await checkSession();
  if (authed) connect();
  loadAppVersion();
})();
