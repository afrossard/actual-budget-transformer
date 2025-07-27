#!/bin/bash
cp ./.devcontainer/.bash_aliases ~/
pipx install poetry==2.1.3
poetry completions bash | sudo tee /etc/bash_completion.d/poetry
poetry install
