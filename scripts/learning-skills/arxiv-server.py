"""Fixed MCP bootstrap: this integration has no semantic indexing capability."""
import runpy
from arxiv_mcp_server.tools import download

# Upstream 0.8.1 probes optional pro packages after every cold download.
# Do not enter that unrelated native/model-loading path for our six tools.
download._semantic_dependencies_available = lambda: False
runpy.run_module("arxiv_mcp_server", run_name="__main__")
