import { type FunctionDeclaration, SchemaType, GoogleGenerativeAI, GoogleSearchRetrievalTool, Tool } from "@google/generative-ai";
import { useEffect, useRef, useState, memo, useCallback } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { ToolCall } from "../../multimodal-live-types";
import sanitizeHtml from 'sanitize-html';
import { MultimodalLiveClient } from "../../lib/multimodal-live-client";

const API_KEY = process.env.REACT_APP_GEMINI_API_KEY as string;

const genAI = new GoogleGenerativeAI(API_KEY);

const geminiAsAToolSystemInstructions = `
* Please answer the question as succinctly as possible.
* If the user asks for a specific piece of information, only give that. Each, if it asks for the name of a person, or place, only return that. No sentence around the answer. 
* Don't answer with "Okay, here is my answer, it's *ANSWER* because etc etc." Rather, just answer with ANSWER. 
* Short phrases, only direct answers, unless the user explicitly asks for more. 
* YOU MUST only directly answer the question with direct answer. DO NOT USE sentences unless explicitly asked to.
`

const model = genAI.getGenerativeModel({
    model: "models/gemini-2.0-flash-exp", //2.0-flash-exp should work here but i havent tried it yet
    tools: ([{ googleSearch: {} }] as unknown) as [Tool],
    systemInstruction: geminiAsAToolSystemInstructions
});

const getDataBlockDecl: FunctionDeclaration = {
    name: "getDataBlock",
    description: "gets a contiguous rectangular block of the data matrix. The result with be in a dictionary with a single key `data` which contains a list of lists of strings.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startRow: {
                type: SchemaType.INTEGER,
                description: "The index of the starting row to return."
            },
            startCol: {
                type: SchemaType.INTEGER,
                description: "The index of the starting column to return."
            },
            endRow: {
                type: SchemaType.INTEGER,
                description: "The index of the end row to return, exclusive. Use -1 to return up until (including) the last row."
            },
            endCol: {
                type: SchemaType.INTEGER,
                description: "The index of the end column to return, exclusive. Use -1 to return up until (including) the last column."
            },

        },
        required: ['startRow', 'startCol', 'endRow', 'endCol'],

    }
}

const getStyleBlockDecl: FunctionDeclaration = {
    name: "getStyleBlock",
    description: "gets a contiguous rectangular block of the CSS style matrix that controls the style of each cell. The result with be in a dictionary with a single key `styles` which contains a list of lists of strings. Each string is a JSON object representing the style.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startRow: {
                type: SchemaType.INTEGER,
                description: "The index of the starting row to return."
            },
            startCol: {
                type: SchemaType.INTEGER,
                description: "The index of the starting column to return."
            },
            endRow: {
                type: SchemaType.INTEGER,
                description: "The index of the end row to return, exclusive. Use -1 to return up until (including) the last row."
            },
            endCol: {
                type: SchemaType.INTEGER,
                description: "The index of the end column to return, exclusive. Use -1 to return up until (including) the last column."
            },

        },
        required: ['startRow', 'startCol', 'endRow', 'endCol'],

    }
}




const setDataBlockDecl: FunctionDeclaration = {
    name: "setDataBlock",
    description: "Sets a contiguous rectangular block of the data matrix with the values of a sub matrix.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startRow: {
                type: SchemaType.INTEGER,
                description: "The index of the starting row to fill."
            },
            startCol: {
                type: SchemaType.INTEGER,
                description: "The index of the starting column to fill."
            },
            value: {
                type: SchemaType.ARRAY,
                items: {
                    type: SchemaType.ARRAY,
                    items: {
                        type: SchemaType.STRING
                    }
                },
                description: "The values to fill the contiguous block with. Strings can contain <a> tags."
            }
        },
        required: ['startRow', 'startCol', 'value'],

    }
}

const setStylesBlockDecl: FunctionDeclaration = {
    name: "setStylesBlock",
    description: "Sets a contiguous rectangular block of the CSS style matrix with the values of a sub matrix.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startRow: {
                type: SchemaType.INTEGER,
                description: "The index of the starting row to fill."
            },
            startCol: {
                type: SchemaType.INTEGER,
                description: "The index of the starting column to fill."
            },
            value: {
                type: SchemaType.ARRAY,
                items: {
                    type: SchemaType.ARRAY,
                    items: {
                        type: SchemaType.STRING
                    }
                },
                description: "The values to fill the contiguous block with. Each value of the matrix should be a JSON object representing the css style for the table cell."
            }
        },
        required: ['startRow', 'startCol', 'value'],

    }
}



const geminiAsAToolDecl: FunctionDeclaration = {
    name: "gemini",
    description: "Returns the response from gemini given the prompt. Response is return as dictionary with a response key that has the model response.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            prompt: {
                type: SchemaType.STRING,
                description: "Prompt to be given to the model."
            },
            // useSearch: {
            //     type: SchemaType.BOOLEAN,
            //     description: "Should Google Search be used as tool"
            // }
        },
    }
}

function range(start: number, end: number) {
    return Array.from({ length: end - start }, (_, i) => i + start)
}

type Dictionary = {
    [key: string]: any
}

type Matrix<Type> = Type[][]

function newMatrix<Type>(size: number, fill: Type): Type[][] {
    return range(0, size).map(_ => Array(size).fill(fill));
}

function resolve_index(index: number, length: number): number {
    return index < 0 ? length + index + 1 : index;
}

function updateMatrixBlock<Type>(
    matrix: Matrix<Type>,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    value: Type): Matrix<Type> {

    const newStartRow = resolve_index(startRow, matrix.length)
    const newStartCol = resolve_index(startCol, matrix.length)
    const newEndRow = resolve_index(endRow, matrix.length);
    const newEndCol = resolve_index(endCol, matrix.length);


    const cloned = matrix.map(row => row.slice());
    for (var rowIndex = newStartRow; rowIndex < newEndRow; rowIndex++) {
        for (var colIndex = newStartCol; colIndex < newEndCol; colIndex++) {
            cloned[rowIndex][colIndex] = value
        }
    }
    return cloned;

}

function setMatrixBlock<Type>(
    matrix: Matrix<Type>,
    startRow: number,
    startCol: number,
    value: Matrix<Type>): Matrix<Type> {

    const newStartRow = resolve_index(startRow, matrix.length)
    const newStartCol = resolve_index(startCol, matrix.length)
    const newEndRow = newStartRow + value.length;

    const cloned = matrix.map(row => row.slice());
    try {
        for (var rowIndex = newStartRow; rowIndex < newEndRow; rowIndex++) {
            if (value[rowIndex - newStartRow] != undefined) {
                const newEndCol = newStartCol + value[rowIndex - newStartRow].length;
                for (var colIndex = newStartCol; colIndex < newEndCol; colIndex++) {
                    if (value[rowIndex - newStartRow][colIndex - newStartCol] != undefined)
                        cloned[rowIndex][colIndex] = value[rowIndex - newStartRow][colIndex - newStartCol]
                }
            }
        }
    }
    catch (exp) {
        console.log(exp)
        return cloned
    }
    return cloned;

}



function selectMatrixBlock<Type>(
    matrix: Matrix<Type>,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number): Matrix<Type> {

    const newStartRow = resolve_index(startRow, matrix.length)
    const newStartCol = resolve_index(startCol, matrix.length)
    const newEndRow = resolve_index(endRow, matrix.length);
    const newEndCol = resolve_index(endCol, matrix.length);

    const result: Type[][] = [];
    for (var rowIndex = newStartRow; rowIndex < newEndRow; rowIndex++) {
        const newRow: Type[] = [];
        for (var colIndex = newStartCol; colIndex < newEndCol; colIndex++) {
            newRow.push(matrix[rowIndex][colIndex])
        }
        result.push(newRow);
    }
    return result
}



// https://blixtdev.com/how-to-use-contenteditable-with-react/
function MatrixCell(props: { text: string, editable: boolean, onSubmit: (newValue: string) => void }) {

    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (ref.current && props.editable) {
            ref.current.focus()
        }
    }, [props.editable])

    function sanitize(dirty: string) {
        return sanitizeHtml(dirty, {
            allowedTags: ['b', 'i', 'em', 'strong', 'a'],
            allowedAttributes: {
                'a': ['href']
            },
        })
    }

    if (!props.editable) return (
        <div dangerouslySetInnerHTML={{ __html: sanitize(props.text) }}>
        </div>
    );
    else {
        return (
            <div contentEditable
                ref={ref}
                onBlur={evt => props.onSubmit(sanitize(evt.currentTarget.innerHTML))}
                onKeyDown={evt => {
                    if (evt.key === "Enter") {
                        props.onSubmit(sanitize(evt.currentTarget.innerHTML))
                    }
                }}
                dangerouslySetInnerHTML={{ __html: sanitize(props.text) }}>
            </div>
        )
    }
}

const developer_instruction = `
# General 
* You are a helpful matrix agent that can change and observe a 10x10 data matrix.
* DO always execute what the user asks, do not ask for confirmation (and do an educated guess if it's unclear). 

# Matrix Operations
* When you do sorting, ignore all empty rows or columns and only sort sections with actual data.
* Make sure to load data from the matrix instead of relying on your previous responses and context. The matrix might have been reordered, sorted etc since you last filled it, so you can't rely on initial orderings.
* When cells are moved (sorted, moved etc), always assume you need to move both content and styling.
* If you don't know/haven't yet seen specific cells and need to process them based on their format, analyze the format first. 
* For example, if you need to parse currency amounts in a column, first print out some dates in the column to see the currency format.
* When you add a title row or column, make sure to not overwrite existing content and shift content accordingly. 

# Parsing strings for python processing
* Often you will have extract specific information from strings, such as days, months and years from a date string. ALWAYS first print at least a subset of the relevant data to figure out what the format is! Don't assume a given format. 
* For example, when you sort by dates, check the date format and do date extraction and conversation based on the pattern you see. 
* Generally, strings in the cells created by an LLM will have various formats. Don't assume you can directly string match on these.
* 
# Gemini As A Tool
* You have a gemini tool you should use whenever the user asks you to process specific cells.
* For example, if you are to find the sentiment of sentences in the second column and write into the third, process each with gemini and write it out.
* Or when you are ask to do something for each cell in a column, and the task requires reasoning or gathering factual information, use gemini as a tool! 
* When using gemini in the inner loop, please update cells as you go so that the user can see changes right away. 
* That is, if you are ready to make a change to cell i,j call default_api.setDataBlock(startCol=i, endCol=j, startRow=i+1, endRow=j+1, value=[[<newValue]])
* So do the default_api.setDataBlock operation in the inner loops, not at the end.
* Use search as a tool if you are asked for factual information, but NOT for per cell processing. For cell specific tasks, use MUST USE gemini as a tool!
* AVOID CALLING SEARCH TOOL N times for N cells. RATHER CALL GEMINI N times. 
* In for loops that create new cell values, store results immediately in the matrix, on a cell-by-cell basis.
* Never use your internal knowledge, always use gemini as a tool if you are asked factual questions.

# CSS Styling operations
* When the user asks for styling, always combine the previous style (retrieve it using the get methods) with the styles to add, unless the user wants to explicitly reset styles. 
* When combining or manipulating JSON style strings, it's best to first parse these into python objects, then manipulate, and the stringify again.
* make sure to 'import json' when you work with json strings and objects. Re-import in each code block. 
* The empty style is represented as "{}" (notice the double quotes, they are critical).
* Note that style changes in the cells overwrite column styles. 

# Date 
* The date is Monday 16 December 2024. 
`

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

export const GeminiMatrix = () => {

    const [data, setData] = useState<string[][]>(newMatrix(10, ""));
    const [cellStyles, setCellStyles] = useState<Dictionary[][]>(newMatrix(10, { border: "1px solid gray", width: "80px", height: "40px" }));
    const [editCell, setEditCell] = useState<{ row: number, col: number } | undefined>(undefined)

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
                        text: developer_instruction,
                    },
                ],
            },
            tools: [
                // there is a free-tier quota for search
                { googleSearch: {} },
                // { codeExecution: {} },
                {
                    functionDeclarations: [
                        getDataBlockDecl,
                        setDataBlockDecl,
                        getStyleBlockDecl,
                        setStylesBlockDecl,
                        geminiAsAToolDecl
                    ]
                },
            ],
        });
    }, [setConfig]);

    const onToolCall = useCallback(async (toolCall: ToolCall) => {


        // console.log(data);
        console.log(`got toolcall`, toolCall);
        toolCall.functionCalls.forEach(async (fc) => {
            switch (fc.name) {
                case geminiAsAToolDecl.name: {
                    const args = fc.args as { prompt: string };
                    const chatSession = model.startChat({
                        history: [],
                        generationConfig: {}
                    });

                    const response = await chatSession.sendMessage(args.prompt);
                    const text = response.response.text()
                    console.log("Response: ", text);
                    sendToolResponse(client, toolCall, { response: text })
                    break
                }
                case setDataBlockDecl.name: {
                    const args = fc.args as { startRow: number, endRow: number, startCol: number, endCol: number, value: string[][] };
                    try {
                        setData(matrix => setMatrixBlock(matrix, args.startRow, args.startCol, args.value));
                        sendToolResponse(client, toolCall, { output: { sucess: true } })
                    } catch (err) {
                        sendToolResponse(client, toolCall, { output: { exception: err } })

                    }
                    break;
                }
                case setStylesBlockDecl.name: {
                    const args = fc.args as { startRow: number, endRow: number, startCol: number, endCol: number, value: string[][] };
                    const cssValue = args.value.map(row => row.map(style => JSON.parse(style)))
                    try {
                        setCellStyles(matrix => setMatrixBlock(matrix, args.startRow, args.startCol, cssValue));
                        sendToolResponse(client, toolCall, { output: { sucess: true } })
                    } catch (err) {
                        sendToolResponse(client, toolCall, { output: { exception: err } })
                    }
                    break;
                }
                case getDataBlockDecl.name: {
                    const args = fc.args as { startRow: number, endRow: number, startCol: number, endCol: number };
                    const result = selectMatrixBlock(data, args.startRow, args.startCol, args.endRow, args.endCol);
                    sendToolResponse(client, toolCall, { data: result })
                    break;
                }
                case getStyleBlockDecl.name: {
                    const args = fc.args as { startRow: number, endRow: number, startCol: number, endCol: number };
                    const result = selectMatrixBlock(cellStyles, args.startRow, args.startCol, args.endRow, args.endCol);
                    const asJSON = result.map(row => row.map(style => JSON.stringify(style)))
                    sendToolResponse(client, toolCall, { styles: asJSON })
                    break;
                }

            }
        });

    }, [data, cellStyles]);

    useEffect(() => {

        client.on("toolcall", onToolCall);
        return () => {
            client.off("toolcall", onToolCall);
        };
    }, [client, onToolCall]);

    return (
        <div style={{ overflow: "auto", height: "500px" }}>
            <table style={{ borderCollapse: "collapse" }}>

                <tbody>
                    {data.map((rowData, rowIndex) =>
                        <tr key={`row ${rowIndex}`}>
                            {rowData.map((cellData, colIndex) =>
                                <td key={`cell ${rowIndex}, ${colIndex}`}
                                    style={cellStyles[rowIndex][colIndex]}
                                    onClick={evt => setEditCell({ row: rowIndex, col: colIndex })}>
                                    <MatrixCell
                                        editable={editCell != undefined && editCell.row === rowIndex && editCell.col == colIndex}
                                        text={cellData}
                                        onSubmit={newValue => {
                                            setData(data => updateMatrixBlock(data, rowIndex, colIndex, rowIndex + 1, colIndex + 1, newValue));
                                            setEditCell(undefined);
                                            sendUserMessage(client, `<CHANGED CELL> (${rowIndex},${colIndex}) to '${newValue}'`)
                                        }}

                                    />
                                </td>)}
                        </tr>)}
                </tbody>
            </table>
        </div>
    )
};


