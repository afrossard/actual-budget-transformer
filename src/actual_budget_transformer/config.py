"""Configuration management for actual_budget_transformer."""

import os
from pathlib import Path

import yaml

from actual_budget_transformer.logging_config import logger

# Environment variable for config path
CONFIG_PATH_ENV = "ACTUAL_BUDGET_TRANSFORMER_CONFIG"

# Minimal base configuration
BASE_CONFIG = {"processors": {}, "output": {}}


class _ConfigManager:
    """Manages loading and caching of the application configuration."""

    def __init__(self):
        self._config_cache: dict | None = None

    def load(self, config_path_override: str | None = None) -> dict:
        """
        Load configuration from a YAML file, caching the result.

        A new path can be provided to force a reload, which updates the cache.
        """
        # Return cached config if available and no override is provided
        if self._config_cache is not None and config_path_override is None:
            return self._config_cache

        config = BASE_CONFIG.copy()

        # Determine which config path to use
        config_path = config_path_override or os.environ.get(CONFIG_PATH_ENV)

        if not config_path:
            logger.warning(
                "Configuration file not specified via argument or "
                "%s environment variable. Using default settings. "
                "Please copy config.template.yml to create your "
                "configuration.",
                CONFIG_PATH_ENV,
            )
            self._config_cache = config
            return self._config_cache

        try:
            path = Path(config_path)
            if path.exists():
                with open(path, encoding="utf-8") as f:
                    loaded_config = yaml.safe_load(f)
                    if loaded_config:
                        logger.info("Loaded configuration from %s", path)
                        config.update(loaded_config)
            else:
                logger.warning(
                    "Config file not found at %s. Using default settings.", path
                )
        except (OSError, yaml.YAMLError) as e:
            logger.error("Failed to load config from %s: %s", config_path, e)

        # Cache the loaded configuration
        self._config_cache = config
        return self._config_cache


# Singleton instance to manage configuration state
_config_manager = _ConfigManager()


def load_config(config_path_override: str | None = None) -> dict:
    """
    Load configuration from a YAML file.

    The configuration is loaded once and cached.
    Subsequent calls return the cached version.
    The config file location is determined in the following order:
    1. The `config_path_override` argument.
    2. The `ACTUAL_BUDGET_TRANSFORMER_CONFIG` environment variable.

    Args:
        config_path_override: An optional path to a config file to load.

    Returns:
        A dictionary containing the configuration.
    """
    return _config_manager.load(config_path_override)


def get_processor_config(processor_name: str) -> dict:
    """
    Get configuration for a specific processor.

    Args:
        processor_name: Name of the processor (e.g., 'ubs_csv')

    Returns:
        Dict containing processor configuration
    """
    config = load_config()
    return config.get("processors", {}).get(processor_name, {})


def get_account_name(account_id: str) -> str:
    """
    Get friendly name for an account identifier from configuration.

    Looks up the top-level ``account_names`` mapping first, then falls
    back to per-processor ``account_names`` for backwards compatibility.

    Args:
        account_id: The account identifier to look up (IBAN, card number, etc.)

    Returns:
        Friendly name if found, cleaned identifier if not found
    """
    config = load_config()
    clean_id = account_id.replace(" ", "")

    # Top-level account_names (preferred)
    friendly_name = config.get("account_names", {}).get(clean_id)
    if friendly_name:
        logger.debug("Found friendly name '%s' for %s", friendly_name, account_id)
        return friendly_name

    # Fallback: per-processor account_names (backwards compat)
    for proc_config in config.get("processors", {}).values():
        if isinstance(proc_config, dict):
            friendly_name = proc_config.get("account_names", {}).get(clean_id)
            if friendly_name:
                logger.debug(
                    "Found friendly name '%s' for %s (processor config)",
                    friendly_name,
                    account_id,
                )
                return friendly_name

    logger.debug("No friendly name found for %s", account_id)
    return clean_id
