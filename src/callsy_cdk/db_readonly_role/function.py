from collections.abc import Sequence

from aws_cdk import Duration
from aws_cdk.aws_ec2 import ISecurityGroup, IVpc, SubnetSelection
from aws_cdk.aws_lambda import Function, Runtime
from constructs import Construct

from callsy_cdk.db_readonly_role.code import HandlerCode

# Enough for one Postgres connection and a PBKDF2 pass.
MEMORY_SIZE_MIB = 256

# Two Postgres connections, a handful of statements and one PBKDF2 pass fit well inside this.
TIMEOUT = Duration.minutes(2)


class DatabaseReadonlyRoleFunction(Function):
    """
    Function behind the read-only role custom resource.

    It connects to the cluster as the master user and converges the role.
    It carries no environment variables, so every value arrives in the resource properties.
    """

    def __init__(
            self,
            scope: Construct,
            id: str,
            *,
            function_name: str | None = None,
            runtime: Runtime | None = None,
            memory_size: int | None = None,
            timeout: Duration | None = None,
            docker_image: str | None = None,
            vpc: IVpc | None = None,
            vpc_subnets: SubnetSelection | None = None,
            security_groups: Sequence[ISecurityGroup] | None = None
    ) -> None:
        super().__init__(
            scope=scope,
            id=id,
            function_name=function_name,
            runtime=runtime or Runtime.NODEJS_22_X,
            handler="index.handler",
            code=HandlerCode(docker_image=docker_image),
            timeout=timeout or TIMEOUT,
            memory_size=memory_size or MEMORY_SIZE_MIB,
            # No vpc by default. A function placed in a vpc that has no nat gateway and no
            # interface endpoints reaches neither Secrets Manager nor the url CloudFormation
            # expects its response on. Pass one only when the cluster is unreachable without.
            vpc=vpc,
            vpc_subnets=vpc_subnets,
            security_groups=list(security_groups) if security_groups is not None else None
        )
