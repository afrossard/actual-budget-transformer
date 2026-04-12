#!/bin/zsh
cp ./.devcontainer/.zsh_aliases ~/.zsh_aliases
echo 'source ~/.zsh_aliases' >> ~/.zshrc
echo 'eval "$(uv generate-shell-completion zsh)"' >> ~/.zshrc
echo 'eval "$(uvx --generate-shell-completion zsh)"' >> ~/.zshrc
UV_LINK_MODE=copy uv sync
npm install
