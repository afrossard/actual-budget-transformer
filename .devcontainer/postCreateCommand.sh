#!/bin/bash
cp ./.devcontainer/.bash_aliases ~/
pipx install uv==0.9.10
echo 'eval "$(uv generate-shell-completion bash)"' | sudo tee /etc/bash_completion.d/uv
echo 'eval "$(uvx --generate-shell-completion bash)"'  | sudo tee /etc/bash_completion.d/uvx
UV_LINK_MODE=copy uv sync
