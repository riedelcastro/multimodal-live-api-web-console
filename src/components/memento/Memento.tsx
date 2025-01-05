/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { type FunctionDeclaration, SchemaType } from "@google/generative-ai";
import { useEffect, useRef, useState, memo } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { ToolCall } from "../../multimodal-live-types";
import { MultimodalLiveClient } from "../../lib/multimodal-live-client";
import sanitizeHtml from 'sanitize-html';

type Dictionary = {
  [key: string]: any
}

function sanitize(dirty: string) {
  return sanitizeHtml(dirty, {
    allowedTags: ['b', 'i', 'em', 'strong', 'a', 'div'],
    allowedAttributes: false
  })
}

function sendToolResponse(client: MultimodalLiveClient, toolCall: ToolCall, response: Dictionary) {
  setTimeout(
    () =>
      client.sendToolResponse({
        functionResponses: toolCall.functionCalls.map((fc) => ({
          response: response,
          id: fc.id,
        })),
      }),
    200,
  );
}

function sendUserMessage(client: MultimodalLiveClient, text: string) {
  setTimeout(
      () =>
          client.send([{ text: text }]),
      200,
  );
}


const renderHtmlDeclaration: FunctionDeclaration = {
  name: "render_html",
  description: "Displays content in html format, embedded in a div element on the current page. ",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      htmlText: {
        type: SchemaType.STRING,
        description:
          "HTML content in string format. The content will be embedded within a div element in the current page.",
      },
    },
    required: ["htmlText"],
  },
};

const lsDeclaration: FunctionDeclaration = {
  name: "ls",
  description: "Lists content in current working directory. Result is a dictionary where the 'files' key contains a list of dictionaries representing files. Each dictionary has a 'name' and a 'type' ('file' or 'directory') field.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      verbose: {
        type: SchemaType.BOOLEAN,
        description:
          "Should the output be verbose.",
      },
    },
    required: [],
  },
};

const writeToDeclaration: FunctionDeclaration = {
  name: "writeTo",
  description: "Writes text into a text file",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      fileName: {
        type: SchemaType.STRING,
        description:
          "Name of the file to write to. Will be created if it doesn't exist.",
      },
      contents: {
        type: SchemaType.STRING,
        description:
          "Contents to write into the file.",
      },
      appendFile: {
        type: SchemaType.BOOLEAN,
        description:
          "Should new content be appended to existing content. Defaults to true. Set to false if you want to reset a file.",
      },
    },
    required: ['contents', 'fileName'],
  },
};

const readTxtFileDeclaration: FunctionDeclaration = {
  name: "readTxtFile",
  description: "Reads txt file and returns content as dictionary with 'contents' field that contains the text string.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      fileName: {
        type: SchemaType.STRING,
        description:
          "Name of the file to read.",
      },
    },
    required: ['fileName'],
  },
};

const rmFileDeclaration: FunctionDeclaration = {
  name: "rm",
  description: "Removes a file or directory with the given name.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      fileName: {
        type: SchemaType.STRING,
        description:
          "Name of the file or directory to remove.",
      },
    },
    required: ['fileName'],
  },
};


const systemInstruction = `
# Rendering HTML
* The default background is dark, so make sure that you choose appropriate colours.
* In your HTML string you can add javascript that sends user messages to Gemini. To do so, use 'document.getElementById("memento").sendToGemini("<your prompt here>")'.  
`

async function listFilesInCurrentFolder() {
  const root = await navigator.storage.getDirectory();
  const fileNames = [];
  // for await (let [name, handle] of root) { }

  for await (const handle of root.values())
    fileNames.push({ name: handle.name, type: handle.kind });
  return fileNames;
}

async function writeToFile(name: string, contents: string, append: boolean = true) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable({ keepExistingData: append });
  const file = await fileHandle.getFile();
  console.log("Append: ", append);
  if (append)
    writable.seek(file.size);
  await writable.write(contents);
  await writable.close();
}
async function readTxtFile(name: string) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(name, { create: true });
  const file = await fileHandle.getFile();
  return await file.text();
}

async function removeFile(name:string) {
  const root = await navigator.storage.getDirectory();
  return root.removeEntry(name);
}

function MementoComponent() {
  const [htmlString, setHtmlString] = useState<string>("");
  const { client, setConfig } = useLiveAPIContext();

  useEffect(() => {
    setConfig({
      model: "models/gemini-2.0-flash-exp",
      generationConfig: {
        responseModalities: "text",
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
        maxOutputTokens: 5000,
      },
      systemInstruction: {
        parts: [
          {
            text: systemInstruction,
          },
        ],
      },
      tools: [
        // there is a free-tier quota for search
        { googleSearch: {} },
        { functionDeclarations: [renderHtmlDeclaration, lsDeclaration, writeToDeclaration, readTxtFileDeclaration, rmFileDeclaration] },
      ],
    });
  }, [setConfig]);


  type MementoElementType = HTMLElement & { sendToGemini?: (prompt: string) => void};

  useEffect(() => {
    const memento = document.getElementById("memento") as MementoElementType;
    memento.sendToGemini = (prompt:string) => {
      console.log("Client is", client);
      console.log("Prompt is: ", prompt);
      sendUserMessage(client, prompt);
    }
    console.log("Extra function set");
  }, [client])

  useEffect(() => {
    const onToolCall = (toolCall: ToolCall) => {
      console.log(`got toolcall`, toolCall);
      toolCall.functionCalls.forEach(async (fc) => {
        switch (fc.name) {
          case renderHtmlDeclaration.name: {
            const args = fc.args as { htmlText: string };
            setHtmlString(args.htmlText);
            sendToolResponse(client, toolCall, { response: { output: { sucess: true } } });
            break
          }
          case lsDeclaration.name: {
            const args = fc.args as { verbose: boolean };
            const result = await listFilesInCurrentFolder();
            sendToolResponse(client, toolCall, { files: result });
            break
          }
          case writeToDeclaration.name: {
            const args = fc.args as { contents: string, fileName: string, appendFile?: boolean };
            const result = await writeToFile(args.fileName, args.contents, args.appendFile === undefined ? true : args.appendFile);
            sendToolResponse(client, toolCall, { response: { output: { sucess: true } } });
            break
          }
          case readTxtFileDeclaration.name: {
            const args = fc.args as { fileName: string };
            const result = await readTxtFile(args.fileName);
            sendToolResponse(client, toolCall, { contents: result });
            break
          }
          case rmFileDeclaration.name: {
            const args = fc.args as { fileName: string };
            const result = await removeFile(args.fileName);
            sendToolResponse(client, toolCall, { response: { output: { sucess: true } } });
            break
          }
        }
      });
    };
    client.on("toolcall", onToolCall);
    return () => {
      client.off("toolcall", onToolCall);
    };
  }, [client]);

  return <div className="memento" id="memento" dangerouslySetInnerHTML={{ __html: htmlString }} />;
}

export const Memento = memo(MementoComponent);
