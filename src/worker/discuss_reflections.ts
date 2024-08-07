import { Handler, SQSEvent, SQSRecord } from "aws-lambda";
import { connectToDatabase } from "../utils/astradb";
import openai from "../utils/openai";
import { generateSecretKey } from "../utils/generateSecretKey";
import { newUserInfo } from "../utils/newUserInfo";
// @ts-ignore
import { getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import snsClient from "../utils/snsClient";
import { PublishCommand } from "@aws-sdk/client-sns";

/**
 * discuss reflections
 * only listen kind = 1
 */
export const handler: Handler = async (event: SQSEvent, context) => {
  const records = event.Records;

  const { db } = await connectToDatabase();

  const processRecord = async (record: SQSRecord) => {
    try {
      const _event = JSON.parse(record.body);
      const isValid = verifyEvent(_event);

      if (!isValid) {
        return;
      }

      if (_event.kind !== 1) {
        return;
      }

      const pubkey = _event.pubkey;

      const prompt = `#### User Requirement Description:
The user will write a reflection on their memories, dreams, or thoughts. Your task is to:

1. Identify multiple historical texts that closely match the user's reflection and evoke emotional resonance.
2. These texts can be quotes from historical figures or characters in literature.
3. Ensure the texts are authentic and not fictional.

#### Return Format:
If suitable texts are found, use the user's language to respond and return a JSON array with each element containing:

- \`"name"\`: The author or character of the text.
- \`"text"\`: The text that resonates with the user's reflection.

Example:
\`\`\`json
{
  "data": [
  {"name": "Li Bai", "text": "Heaven has endowed me with talents, and they will be put to good use. Wealth may be scattered, but it will return."},
  {"name": "Marcus Aurelius", "text": "The happiness of your life depends upon the quality of your thoughts."}
]
}
\`\`\`

If no suitable texts are found, return an empty array.`;

      const request = await openai.chat.completions.create({
        messages: [
          {
            role: "system",
            content: prompt,
          },
          {
            role: "user",
            content: _event.content,
          },
        ],
        model: "gpt-4o",
        stream: false,
        temperature: 0.8,
        max_tokens: 4096,
        response_format: {
          type: "json_object",
        },
        user: pubkey,
      });

      const reply = request.choices[0].message.content;

      if (!reply) {
        return;
      }

      const data = JSON.parse(reply)?.data || [];

      for (let i = 0; i < data.length; i++) {
        const item = data[i];

        const salt = process.env.SALT || "0";

        let userSk = generateSecretKey(salt, item.name.toLowerCase()); // `sk` is a Uint8Array
        const userPubkey = getPublicKey(userSk);

        const exist = await db.collection("events").findOne({
          kind: 0,
          pubkey: userPubkey,
        });

        if (!exist) {
          await newUserInfo(item.name, userSk, userPubkey, db);
        }

        const tags = [
          ["e", _event.id],
          ["p", _event.pubkey],
          ["alt", "reply"],
        ];
        const comment_event = finalizeEvent(
          {
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: item.text,
          },
          userSk,
        );

        const result = await snsClient.send(
          new PublishCommand({
            TopicArn: process.env.NOSTR_EVENTS_SNS_ARN,
            Message: JSON.stringify(comment_event),
            MessageAttributes: {
              kind: {
                DataType: "Number",
                StringValue: comment_event.kind.toString(),
              },
              premium: {
                DataType: "Number",
                StringValue: "0", // bot is not premium user
              },
            },
          }),
        );

        if (!result.MessageId) {
          console.log("Error: SNS");
        }
      }
    } catch (_) {
      throw new Error("Intentional failure to trigger DLQ");
    }
  };

  await Promise.all(records.map(processRecord));

  console.log(`Successfully processed ${records.length} records.`);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true }),
  };
};
