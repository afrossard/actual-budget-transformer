#!/bin/zsh
cp ./.devcontainer/.zsh_aliases ~/.zsh_aliases
echo 'source ~/.zsh_aliases' >> ~/.zshrc

# Neutralise the host's docker credsStore (macOS sets "desktop", whose helper
# binary doesn't exist inside this Linux container). Without this, `docker
# build`/`compose build` for public images fails with "error getting credentials".
mkdir -p ~/.docker && echo '{}' > ~/.docker/config.json
echo 'eval "$(uv generate-shell-completion zsh)"' >> ~/.zshrc
echo 'eval "$(uvx --generate-shell-completion zsh)"' >> ~/.zshrc
UV_LINK_MODE=copy uv sync
npm install
