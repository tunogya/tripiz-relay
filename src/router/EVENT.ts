import { Handler, APIGatewayEvent } from "aws-lambda";
import snsClient from "../utils/snsClient";
import { PublishCommand } from "@aws-sdk/client-sns";

export const handler: Handler = async (event: APIGatewayEvent, context) => {
  try {
    // @ts-ignore
    const messageType = event[0];
    if (messageType !== "EVENT") {
      return;
    }
    // @ts-ignore
    const { id, kind, pubkey, created_at, content, tags, sig } = event[1];
    const category =
      tags.find((tag: any[]) => tag[0] === "category")?.[1] || undefined;
    const message = await snsClient.send(
      new PublishCommand({
        TopicArn: process.env.NOSTR_SNS_ARN,
        Message: JSON.stringify({
          id,
          kind,
          pubkey,
          created_at,
          content,
          tags,
          sig,
        }),
        MessageAttributes: {
          kind: {
            DataType: "Number",
            StringValue: kind.toString(),
          },
          ...(category && {
            category: { DataType: "String", StringValue: category },
          }),
        },
      }),
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Something went wrong.",
      }),
    };
  }
};