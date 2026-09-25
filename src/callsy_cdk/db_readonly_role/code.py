from pathlib import Path

from aws_cdk import BundlingOptions, DockerImage
from aws_cdk.aws_lambda import AssetCode

# Image the handler dependencies are installed with.
DEFAULT_DOCKER_IMAGE = "node:22-alpine"


class HandlerCode(AssetCode):
    """
    Handler source with its dependencies installed at synthesis.

    The path is resolved from this file rather than from the working directory, so it holds
    wherever the package happens to be installed.
    """

    def __init__(self, docker_image: str | None = None) -> None:
        command = [
            "cp -r /asset-input/* /asset-output/",
            "cd /asset-output/",
            "npm install --cache /tmp/.npm_cache"
        ]

        super().__init__(
            path=str(Path(__file__).parent / "source"),
            bundling=BundlingOptions(
                image=DockerImage(image=docker_image or DEFAULT_DOCKER_IMAGE),
                entrypoint=["/bin/sh"],
                command=["-c", " && ".join(command)],
                platform="linux/amd64"
            )
        )
