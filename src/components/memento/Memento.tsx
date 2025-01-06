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
import { type FunctionDeclaration, GenerativeContentBlob, Part, SchemaType } from "@google/generative-ai";
import { useEffect, useRef, useState, memo, Attributes, useLayoutEffect } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { ToolCall } from "../../multimodal-live-types";
import { MultimodalLiveClient } from "../../lib/multimodal-live-client";
import sanitizeHtml from 'sanitize-html';
import * as htmlparser2 from "htmlparser2";
import { DomHandler, DomHandlerOptions, Node, Element, Document, Text } from "domhandler";
import { Helmet } from "react-helmet";


type Dictionary = {
  [key: string]: any
}

function sanitize(dirty: string) {
  console.log("Dirty HTML:", dirty);

  const sanitized = dirty.replace(/<script>.*<\/script>/s, "");
  const scripts = /<script>(.*)<\/script>/s.exec(dirty);
  var scriptContent = ""
  if (scripts != null) {
    scriptContent = scripts[1];
  }

  console.log("Sanitized: ", sanitized);
  console.log("Script: ", scriptContent);
  return {
    santitized: sanitized,
    scripts: scriptContent
  };
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

function sendUserImage(client: MultimodalLiveClient, data: string) {
  setTimeout(
    () => {
      // const contentBlob: GenerativeContentBlob = {
      //   mimeType: "image/jpeg",
      //   data: data
      // };
      // const part: Part = { inlineData: contentBlob };
      // client.send([part], true );
      // https://github.com/google-gemini/cookbook/blob/main/gemini-2/live_api_starter.py#L76-L119
      client.sendRealtimeInput([{ mimeType: "image/jpeg", data: data }])
      // client.sendRealtimeInput([{mimeType:  "audio/pcm;rate=16000", data: ""}])

    },
    200,
  );
}


const renderHtmlDeclaration: FunctionDeclaration = {
  name: "render_html",
  description: "Renders an html page in an iframe.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      htmlText: {
        type: SchemaType.STRING,
        description:
          "HTML page in string format.",
      },
    },
    required: ["htmlText"],
  },
};

const sendMessageToIframeDeclaration: FunctionDeclaration = {
  name: "send_message_to_iframe",
  description: "Sends a message to the iframe that contains the rendered html. You can receive these messages within the javascript you generate.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      message: {
        type: SchemaType.STRING,
        description:
          "message to be sent to the iframe.",
      },
    },
    required: ["message"],
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

const oldSystemInstruction = `
# Rendering HTML
* The default background is dark, so make sure that you choose appropriate colours. 
* Inline Javascript in event handlers can send content back to gemini via 'document.getElementById("memento").sendToGemini("<your prompt here>")'.
* Inline Javascript in event handlers can also send image content back to gemini via 'document.getElementById("memento").sendImageToGemini("<your image in image/jpeg format as base64 string here>")'.

`

const systemInstruction = `
# Rendering HTML
* The default background is dark, so make sure that you choose appropriate colours. 
* In the HTML you can use javascript to send messages to Gemini via 'window.parent.postMessage({type: "userResponse", prompt: "<your prompt here>"}, "http://localhost:3000")'; 
* You can also listen to messages send from Gemini via 'window.addEventListener("message", <your message listener here>)'. The message will have the type: 'modelResponse' and the response will be in the 'response' property.
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

async function removeFile(name: string) {
  const root = await navigator.storage.getDirectory();
  return root.removeEntry(name);
}

const dummyHtml = `
<html>
  <body>
     Hello World
     <script>
        const someVar = 123;
        console.log("IFrame script called", someVar);
        console.log("IFrame parent window",window.parent);
        console.log("Memento", document.getElementById('memento'));
        console.log("Origin", window.location.origin);
        window.parent.postMessage('Yo!', "http://localhost:3000/"); 
        document.addEventListener('DOMContentLoaded', function (event) {
          console.log("DOM content has loaded");
          console.log("Doc", document);
          // console.log("Parent", window.parent.document);
        })
     </script>
  </body>
</html>
`

function MementoComponent() {
  const [htmlString, setHtmlString] = useState<string>("");
  const { client, connected, setConfig } = useLiveAPIContext();
  const elRef = useRef<HTMLDivElement>(null);


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
        { functionDeclarations: [renderHtmlDeclaration, lsDeclaration, writeToDeclaration, readTxtFileDeclaration, rmFileDeclaration, sendMessageToIframeDeclaration] },
      ],
    });
  }, [setConfig]);

  function onReceivedMessage(event: MessageEvent) {
    console.log("Message received: ", event.data);
    console.log("Event Received: ", event);
    console.log("Origin", event.origin);
    if (event.origin == "http://localhost:3000" && event.data.type == "userResponse") {
      sendUserMessage(client, event.data.prompt);
      console.log("Sent to gemini");
    }
  }

  useEffect(() => {
    window.addEventListener("message", onReceivedMessage);

    return () => {
      window.removeEventListener("message", onReceivedMessage);
    };
  })


  type MementoElementType = HTMLElement & {
    sendToGemini?: (prompt: string) => void,
    sendImageToGemini?: (data: string) => void
  };

  useEffect(() => {
    const memento = document.getElementById("memento") as MementoElementType;
    memento.sendToGemini = (prompt: string) => {
      console.log("Client is", client);
      console.log("Prompt is: ", prompt);
      sendUserMessage(client, prompt);
    }
    memento.sendImageToGemini = (data: string) => {
      sendUserImage(client, data);
      console.log("Image send");
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
          case sendMessageToIframeDeclaration.name: {
            const args = fc.args as { message: string };
            const iframe = document.getElementById('html_canvas') as HTMLIFrameElement;
            iframe?.contentWindow?.postMessage({type: "modelResponse", response: args.message}, "*");
            // window.parent.postMessage({type: "modelResponse", message: args.message}, "*");
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


  useLayoutEffect(() => {
    if (elRef.current != null) {
      const iframe = document.createElement('iframe');
      iframe.width = "1000px";
      iframe.height = "600px";
      iframe.style.border = "none";
      iframe.srcdoc = htmlString;
      iframe.id = "html_canvas";
      // iframe.src = 'data:text/html;charset=utf-8,' + htmlString;
      elRef.current.appendChild(iframe);
      console.log("Iframe", iframe);
      console.log('iframe.contentWindow =', iframe.contentWindow);
      return () => {
        elRef.current?.removeChild(iframe);
      }
    }
  }, [htmlString])

  return <div>
    <div ref={elRef} className="memento" id="memento" />
  </div>;
}

export const Memento = memo(MementoComponent);
