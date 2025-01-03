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
import { appendFile } from "fs";

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


const renderHtmlDeclaration: FunctionDeclaration = {
  name: "render_html",
  description: "Displays HTML on the screen.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      htmlText: {
        type: SchemaType.STRING,
        description:
          "HTML object in string format",
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
          "Should new content be appended to existing content. Defaults to true.",
      },
    },
    required: ['contents','fileName'],
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



const systemInstruction = `
* The default background is dark, so make sure that you choose appropriate colours.
* Render responses in html whenever asked to show or render something. 
`

async function setupFileSystem() {
  const root = await navigator.storage.getDirectory();
  const untitledFile = await root.getFileHandle("Untitled.txt", { "create": true });
  // Get access to existing *Untitled.txt* file.
  // untitledFile and existingUntitledFile point to the same entry.
  const existingUntitledFile = await root.getFileHandle("Untitled.txt");
  // Create a directory named *Diary Folder*.
  const diaryDirectory = await root.getDirectoryHandle("Diary Folder", { "create": true });

  console.log("File System set up");
  console.log("Current dir", await listFilesInCurrentFolder());
}

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
  const writable = await fileHandle.createWritable({ keepExistingData: append })
  await writable.write(contents);
  await writable.close();
}
async function readTxtFile(name: string) {
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(name, { create: true });
  const file = await fileHandle.getFile();
  return await file.text();
}


function MementoComponent() {
  const [htmlString, setHtmlString] = useState<string>("");
  const { client, setConfig } = useLiveAPIContext();

  useEffect(() => {
    setupFileSystem();
    setConfig({
      model: "models/gemini-2.0-flash-exp",
      generationConfig: {
        responseModalities: "text",
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
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
        { functionDeclarations: [renderHtmlDeclaration, lsDeclaration, writeToDeclaration, readTxtFileDeclaration] },
      ],
    });
  }, [setConfig]);

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
            const args = fc.args as { contents: string, fileName: string, append?:boolean};
            const result = await writeToFile(args.fileName, args.contents, args.append === undefined ? true : args.append);
            sendToolResponse(client, toolCall, { response: { output: { sucess: true } } });
            break
          }
          case readTxtFileDeclaration.name: {
            const args = fc.args as { fileName: string };
            const result = await readTxtFile(args.fileName);
            sendToolResponse(client, toolCall, { contents: result });
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

  return <div className="memento" dangerouslySetInnerHTML={{ __html: htmlString }} />;
}

export const Memento = memo(MementoComponent);
