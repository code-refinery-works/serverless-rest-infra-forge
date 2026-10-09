import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";

interface Props extends cdk.StackProps { appEnv: string; }

export class ServerlessApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    const isPrd    = props.appEnv === "prd";
    const prefix   = `srvless-${props.appEnv}`;
    const retention = isPrd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;

    // ── DynamoDB ────────────────────────────────────────────
    const table = new dynamodb.Table(this, "ItemsTable", {
      tableName:            `${prefix}-items-table`,
      partitionKey:         { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode:          dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption:           dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery:  isPrd,
      deletionProtection:   isPrd,
      removalPolicy:        isPrd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda ──────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, "LambdaLogs", {
      logGroupName:  `/aws/lambda/${prefix}-item-handler`,
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const handler = new lambda.Function(this, "ItemHandler", {
      functionName:  `${prefix}-item-handler`,
      runtime:       lambda.Runtime.PYTHON_3_12,
      architecture:  lambda.Architecture.ARM_64,
      handler:       "index.lambda_handler",
      code:          lambda.Code.fromAsset(path.join(__dirname, "../../src/handler")),
      timeout:       cdk.Duration.seconds(29),
      logGroup,
      environment: {
        TABLE_NAME: table.tableName,
        ENV:        props.appEnv,
      },
    });

    // 最小権限: 必要な5アクションのみ付与
    table.grantReadWriteData(handler);

    // ── API Gateway HTTP API ────────────────────────────────
    const apigwLogGroup = new logs.LogGroup(this, "ApiGwLogs", {
      logGroupName:  `/aws/apigateway/${prefix}-apigw`,
      retention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${prefix}-apigw`,
      corsPreflight: {
        allowOrigins:  ["*"],
        allowMethods:  [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST,
                        apigwv2.CorsHttpMethod.PUT, apigwv2.CorsHttpMethod.DELETE,
                        apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders:  ["Content-Type", "Authorization"],
        maxAge:        cdk.Duration.seconds(300),
      },
      defaultStage: new apigwv2.HttpStage(this, "DefaultStage", {
        httpApi:     {} as apigwv2.HttpApi,   // overridden by CDK internals
        stageName:   "$default",
        autoDeploy:  true,
      }),
    });

    const integration = new integrations.HttpLambdaIntegration("LambdaInteg", handler, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });

    const routes: [apigwv2.HttpMethod, string][] = [
      [apigwv2.HttpMethod.GET,    "/items"],
      [apigwv2.HttpMethod.POST,   "/items"],
      [apigwv2.HttpMethod.GET,    "/items/{id}"],
      [apigwv2.HttpMethod.PUT,    "/items/{id}"],
      [apigwv2.HttpMethod.DELETE, "/items/{id}"],
    ];
    routes.forEach(([method, routePath]) =>
      api.addRoutes({ path: routePath, methods: [method], integration })
    );

    // ── Outputs ─────────────────────────────────────────────
    new cdk.CfnOutput(this, "ApiEndpoint",       { value: api.apiEndpoint });
    new cdk.CfnOutput(this, "TableName",         { value: table.tableName });
    new cdk.CfnOutput(this, "LambdaFunctionName",{ value: handler.functionName });
  }
}