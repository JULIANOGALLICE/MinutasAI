import { GoogleGenAI, Type } from "@google/genai";

let ai: GoogleGenAI | null = null;
let currentApiKey: string | null = null;

async function getAI() {
  try {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/settings/gemini', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (res.ok) {
      const data = await res.json();
      const apiKey = data.apiKey;
      
      if (!apiKey) {
        throw new Error("Chave da API do Gemini não configurada no sistema.");
      }

      // Re-initialize if the key changed or if it's the first time
      if (!ai || currentApiKey !== apiKey) {
        ai = new GoogleGenAI({ apiKey });
        currentApiKey = apiKey;
      }
      return ai;
    } else {
      throw new Error("Erro ao buscar chave da API do Gemini.");
    }
  } catch (error) {
    // Fallback to env var if running in a context where it's available (like AI Studio)
    if (process.env.GEMINI_API_KEY) {
      if (!ai || currentApiKey !== process.env.GEMINI_API_KEY) {
        ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        currentApiKey = process.env.GEMINI_API_KEY;
      }
      return ai;
    }
    throw error;
  }
}

export async function extractTextFromPdf(base64Pdf: string): Promise<string> {
  try {
    const aiInstance = await getAI();
    const response = await aiInstance.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64Pdf,
          },
        },
        {
          text: "Analise este documento PDF que contém um modelo de escritura (minuta). Extraia APENAS o texto principal referente à estrutura da minuta em si. IGNORE cabeçalhos, rodapés, numeração de páginas, carimbos, assinaturas, dados específicos de cartório que não façam parte do corpo do texto, ou qualquer outra informação desnecessária. Mantenha a formatação, as cláusulas e as quebras de linha do texto principal. Se houver formatações como negrito, itálico ou cores no PDF, represente-as usando tags HTML (<b>, <i>, <span style='color:...'>). Retorne EXCLUSIVAMENTE o texto limpo da minuta com as devidas tags HTML de formatação.",
        },
      ],
    });
    return response.text || "";
  } catch (error: any) {
    console.error("Failed to extract text from PDF", error);
    throw new Error("Erro ao extrair texto do PDF.");
  }
}

export async function extractPeopleFromDocuments(base64Pdf: string): Promise<string[]> {
  try {
    const aiInstance = await getAI();
    const response = await aiInstance.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64Pdf,
          },
        },
        {
          text: "Analise este documento PDF que contém documentos de identificação, certidões e/ou documentos de imóveis. Extraia o nome completo de todas as pessoas físicas principais mencionadas nestes documentos (as partes envolvidas na transação ou ato jurídico). Retorne APENAS uma lista com os nomes completos.",
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING,
            description: "Nome completo da pessoa física",
          },
          description: "Lista de nomes completos das partes envolvidas",
        },
      },
    });

    const jsonStr = response.text?.trim() || "[]";
    return JSON.parse(jsonStr);
  } catch (error: any) {
    console.error("Failed to parse JSON response or Gemini API Error", error);
    if (error.message && error.message.includes("Document size exceeds supported limit")) {
      throw new Error("O tamanho do documento excede o limite suportado de 50MB. Por favor, comprima o arquivo PDF antes de enviar.");
    }
    return [];
  }
}

export async function generateDeedDraft(
  base64Pdf: string,
  deedType: string,
  roles: Record<string, string>,
  minutaContent?: string,
  additionalDetails?: string,
  customInstructions?: string,
  templateInstructions?: string
): Promise<string> {
  const parts: any[] = [
    {
      text: "Abaixo estão os documentos das partes e do imóvel (matrículas, RGs, CPFs, certidões):",
    },
    {
      inlineData: {
        mimeType: "application/pdf",
        data: base64Pdf,
      },
    },
  ];

  if (minutaContent) {
    parts.push({
      text: "Abaixo está o MODELO DE ESCRITURA do cartório. É OBRIGATÓRIO seguir ESTRITAMENTE a estrutura, formatação, jargões, estilo de redação e cláusulas deste modelo. Use-o como um 'template' e apenas substitua os dados das partes e do imóvel pelos dados dos documentos fornecidos.\n\nMODELO:\n" + minutaContent,
    });
  }

  const rolesText = Object.entries(roles)
    .map(([name, role]) => `- ${name}: ${role}`)
    .join("\n");

  const additionalDetailsText = additionalDetails 
    ? `\nInformações e Cláusulas Adicionais (INCLUIR NA MINUTA):\n${additionalDetails}\n` 
    : "";

  let instructions = customInstructions || `Você é um Tabelião de Notas experiente no Brasil.
Com base nos documentos fornecidos, e nas seguintes informações:

Tipo de Escritura solicitada: {{deedType}}

Partes envolvidas e seus respectivos papéis na escritura:
{{rolesText}}
{{additionalDetailsText}}
Por favor, redija a MINUTA COMPLETA da escritura pública solicitada.
Instruções RIGOROSAS:
1. USO INTEGRAL DO MODELO: É OBRIGATÓRIO utilizar o texto do MODELO fornecido de forma INTEGRAL. Mantenha toda a estrutura, todas as cláusulas, jargões e formatação exatamente iguais às do modelo. NÃO APAGUE A ESTRUTURA COMO UM TODO.
2. MARCADORES ESPECÍFICOS: O protocolo geral deve ser mantido estritamente como "[[PROTGERAL]]". A data inicial deve ser mantida estritamente como "[[DATAEXTENSO]]".
3. NÃO CORTE O CABEÇALHO/RODAPÉ E DADOS DO CARTÓRIO: Você DEVE manter a parte inicial (protocolo geral, livro, folha, dados do cartório, dados do oficial/tabelião, selos) e a parte final (assinaturas, encerramento) EXATAMENTE como constam no modelo fornecido. NÃO altere o nome do cartório nem o nome do tabelião que constam no modelo.
4. SUBSTITUIÇÃO DE DADOS: Altere no modelo APENAS os dados das partes, do imóvel, valores e datas, substituindo-os pelas informações encontradas nos documentos enviados.
5. QUALIFICAÇÃO COMPLETA: A qualificação das partes deve ser extremamente detalhada, contendo: nome completo, nacionalidade, documento de identificação (RG, CNH, etc.) com órgão emissor, CPF, profissão, estado civil e, se casado/divorciado/viúvo, a descrição completa da certidão de casamento (livro, folha, termo, cartório e data).
6. DADOS FALTANTES (ESPAÇOS EM BRANCO): Se qualquer informação necessária para a qualificação ou para a escritura NÃO estiver presente nos documentos enviados (ex: profissão, endereço, dados do cônjuge, valores, datas, dados do imóvel), VOCÊ NÃO DEVE INVENTAR NEM OMITIR. Em vez disso, deixe o que falta no formato "-------[NOME_DA_INFORMACAO]------" (por exemplo: "-------PROFISSAO------", "-------ESTADO CIVIL------", "-------ENDERECO------").
7. INFORMAÇÕES ADICIONAIS: Se houver "Informações e Cláusulas Adicionais" fornecidas acima (como forma de pagamento, usufruto, incomunicabilidade, etc.), você DEVE redigir e incluir essas cláusulas no corpo da escritura, adaptando-as ao estilo do modelo.
8. Não resuma a escritura. O resultado final deve ser a escritura completa, pronta para ser lida e preenchida nos espaços faltantes.
9. Retorne o texto formatado em Markdown para facilitar a leitura.`;

  if (templateInstructions) {
    instructions += `\n\nINSTRUÇÕES ESPECÍFICAS DESTA MINUTA:\n${templateInstructions}`;
  }

  instructions += `\n\nATENÇÃO - FORMATAÇÃO RICA (WORD): Você DEVE utilizar tags HTML para formatar o texto (ex: <b>negrito</b>, <i>itálico</i>, <span style="color: red">texto colorido</span>) sempre que solicitado ou para destacar informações. O modelo fornecido também pode conter essas tags HTML, que devem ser estritamente respeitadas e mantidas na saída.`;

  instructions = instructions
    .replace('{{deedType}}', deedType)
    .replace('{{rolesText}}', rolesText)
    .replace('{{additionalDetailsText}}', additionalDetailsText);

  parts.push({
    text: instructions,
  });

  try {
    const aiInstance = await getAI();
    const response = await aiInstance.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: { parts },
      config: {
        temperature: 0.2,
      },
    });

    return response.text || "Erro ao gerar a minuta.";
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    if (error.message && error.message.includes("Document size exceeds supported limit")) {
      throw new Error("O tamanho dos documentos anexados excede o limite suportado de 50MB. Por favor, comprima os arquivos PDF ou divida-os antes de enviar.");
    }
    throw error;
  }
}
