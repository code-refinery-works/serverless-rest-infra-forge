#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ServerlessApiStack } from "../lib/stack";

const app = new cdk.App();

const env = app.node.tryGetContext("env") ?? "dev";
if (!["dev", "prd"].includes(env)) throw new Error("Context 'env' must be 'dev' or 'prd'");

new ServerlessApiStack(app, `SrvlessApi-${env}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
  tags: {
    Project:     "srvless-api",
    Environment: env,
    ManagedBy:   "CDK",
  },
  appEnv: env,
});