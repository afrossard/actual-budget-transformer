# pylint: disable=C0114
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass
class ProcessingResult:
    """
    Container for processing results and metadata.

    Attributes
    ----------
    data : Any
        The processed data (typically a pandas DataFrame)
    output_prefix : str
        The suggested prefix for output files
    metadata : dict
        Additional metadata about the processed file
    """

    data: Any
    output_prefix: str


class BaseProcessor(ABC):
    """
    Abstract base class for file processors.

    This class defines the interface for all file processors, requiring
    implementations to provide methods for determining if a file can be processed
    and for processing the file itself.

    Methods
    -------
    can_process(cls, file_path) -> bool
        Class method that returns True if the processor can handle the given file.

    process(cls, file_path) -> ProcessingResult
        Parse and process the specified file.
    """

    @classmethod
    @abstractmethod
    def can_process(cls, file_path) -> bool:
        """Return True if this processor can handle the file."""

    @abstractmethod
    def process(self, file_path) -> ProcessingResult:
        """
        Parse and process the file.

        Returns
        -------
        ProcessingResult
            Container with processed data and metadata
        """
