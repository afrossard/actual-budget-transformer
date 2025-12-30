# The builder image, used to build the virtual environment
FROM python:3.14-slim-trixie AS builder

# Install UV
COPY --from=ghcr.io/astral-sh/uv:0.9.21 /uv /uvx /bin/

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy from the cache instead of linking since it's a mounted volume
ENV UV_LINK_MODE=copy

# Disable Python downloads, because we want to use the system interpreter
# across both images.
ENV UV_PYTHON_DOWNLOADS=0

# Install the project into `/app`
WORKDIR /app

# Install the project's dependencies using the lockfile and settings
# for optimal image build caching
RUN --mount=type=cache,target=/root/.cache/uv \
  --mount=type=bind,source=uv.lock,target=uv.lock \
  --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
  uv sync \ 
  --locked \
  --no-dev \ 
  --no-editable \
  --no-install-project 

# Copy the project sources into the intermediate image
COPY src /app

# Sync the project
RUN --mount=type=cache,target=/root/.cache/uv \
  --mount=type=bind,source=uv.lock,target=uv.lock \
  --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
  uv sync \
  --locked \
  --no-dev \
  --no-editable

# The runtime image, used to just run the code provided its virtual environment
FROM python:3.14-slim-trixie AS runtime

# Setup a non-root user
RUN groupadd --system --gid 999 app \
  && useradd --system --gid 999 --uid 999 --create-home app

# Copy the environment, but not the source code
COPY --from=builder --chown=app:app /app/.venv /app/.venv

# Place executables in the environment at the front of the path
ENV PATH="/app/.venv/bin:$PATH"

# Use the non-root user to run our application
USER app

# Use `/app` as the working directory
WORKDIR /app

ENTRYPOINT ["python", "-m", "actual_budget_transformer.main"] 
