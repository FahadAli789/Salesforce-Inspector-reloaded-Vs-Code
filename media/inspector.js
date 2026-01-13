import {getRedirectUri, getClientId, Constants} from "./utils.js";

export let defaultApiVersion = "65.0";
export let apiVersion = localStorage.getItem("apiVersion") == null ? defaultApiVersion : localStorage.getItem("apiVersion");

export let sessionError;
const clientId = "Salesforce Inspector Reloaded";

// Auto-detect Proxy Mode immediately upon module load
const _params = new URLSearchParams(window.location.search);
const _isProxy = _params.get("proxy") || _params.get("host") === "VSCodeProxy" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const _hostParam = _params.get("host");

export let sfConn = {
  instanceHostname: (_isProxy && _hostParam && _hostParam !== "VSCodeProxy") ? _hostParam : null,
  sessionId: _isProxy ? "dummy-session-id-handled-by-vscode" : null,
  isProxy: !!_isProxy,

  async getSession(sfHost) {
    if (this.isProxy) {
        // Update/Persist hostname if provided
        if (sfHost && sfHost !== "VSCodeProxy") {
            this.instanceHostname = sfHost;
            localStorage.setItem("vscode_proxy_host", sfHost);
        } else if (!this.instanceHostname) {
            // Recover from storage if we don't have it yet
            const cached = localStorage.getItem("vscode_proxy_host");
            if (cached) this.instanceHostname = cached;
        }
        return this.sessionId;
    }

    const url = new URL(window.location.href);
    const searchParams = new URLSearchParams(url.search);
    
    // Check if we are running in the VS Code Proxy mode (Redundant check but safe)
    if (searchParams.get("host") === "VSCodeProxy" || searchParams.get("proxy")) {
      let hostParam = searchParams.get("host");
      if (hostParam && hostParam !== "VSCodeProxy") {
          this.instanceHostname = hostParam;
          localStorage.setItem("vscode_proxy_host", hostParam);
      } else {
             const cached = localStorage.getItem("vscode_proxy_host");
             if (cached) this.instanceHostname = cached;
      }
      this.sessionId = "dummy-session-id-handled-by-vscode";
      this.isProxy = true;
      return this.sessionId;
    }

    // Double check localhost even if URL params are missing
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      this.sessionId = "dummy-session-id-handled-by-vscode";
      this.isProxy = true;
      const cached = localStorage.getItem("vscode_proxy_host");
      if (cached) this.instanceHostname = cached;
      return this.sessionId;
    }

    // ORIGINAL LOGIC FALLBACK 
    const authorizationCode = searchParams.get("code");
    // ...
    return this.sessionId;
  },

  async exchangeCodeForToken(sfHost, authorizationCode, codeVerifier) {
    // ... (This function remains unchanged, but tool requires context)
    const redirectUri = getRedirectUri("data-export.html");
    const clientId = getClientId(sfHost);

    // Validate redirect URI was successfully generated
    if (!redirectUri || !redirectUri.includes("-extension://")) {
      throw new Error("Failed to generate redirect URI. Extension context may be invalidated. Please reload this page and try again.");
    }

    const tokenUrl = `https://${sfHost}/services/oauth2/token`;
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error_description || "Failed to exchange code for token");
    }

    const tokenData = await response.json();
    return tokenData.access_token;
  },

  async rest(url, {logErrors = true, method = "GET", api = "normal", body = undefined, bodyType = "json", responseType = "json", headers = {}, progressHandler = null, useCache = true} = {}, rawResponse) {
    
       const proxyBody = {
          url: url,
          method: method,
          headers: headers,
          body: body
       };
       if (bodyType == "json" && body !== undefined) {
         // The original code passed object as body, our proxy expects object, so we are good.
         // But if bodyType was "raw", we might need handling.
       }

       const response = await fetch('/api/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(proxyBody)
       });

       if (!response.ok) {
           const err = new Error();
           err.name = "SalesforceRestError";
           try {
             const errorJson = await response.json();
             err.detail = errorJson;
             try {
                // Try to format standard Salesforce errors
                if (Array.isArray(errorJson)) {
                    err.message = errorJson.map(e => `${e.errorCode}: ${e.message}${e.fields && e.fields.length > 0 ? ` [${e.fields.join(", ")}]` : ""}`).join("\n");
                } else if (errorJson.error) {
                    // OAuth type errors
                    err.message = errorJson.error_description || errorJson.error;
                } else {
                    err.message = JSON.stringify(errorJson);
                }
             } catch (formatErr) {
                err.message = JSON.stringify(errorJson);
             }
           } catch(e) {
             err.message = "Proxy Error: " + response.status + " " + response.statusText;
           }
           
           if (!logErrors) console.error(err);
           throw err;
       }

       if (response.status === 204) {
           return null;
       }
       const json = await response.json();
       return json;
  },

  wsdl(apiVersion, apiName) {
    let wsdl = {
      Enterprise: {
        servicePortAddress: "/services/Soap/c/" + apiVersion,
        targetNamespaces: ' xmlns="urn:enterprise.soap.sforce.com" xmlns:sf="urn:sobject.enterprise.soap.sforce.com"',
        apiName: "Enterprise"
      },
      Partner: {
        servicePortAddress: "/services/Soap/u/" + apiVersion,
        targetNamespaces: ' xmlns="urn:partner.soap.sforce.com" xmlns:sf="urn:sobject.partner.soap.sforce.com"',
        apiName: "Partner"
      },
      Apex: {
        servicePortAddress: "/services/Soap/s/" + apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/08/apex"',
        apiName: "Apex"
      },
      Metadata: {
        servicePortAddress: "/services/Soap/m/" + apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/04/metadata"',
        apiName: "Metadata"
      },
      Tooling: {
        servicePortAddress: "/services/Soap/T/" + apiVersion,
        targetNamespaces: ' xmlns="urn:tooling.soap.sforce.com" xmlns:sf="urn:sobject.tooling.soap.sforce.com" xmlns:mns="urn:metadata.tooling.soap.sforce.com"',
        apiName: "Tooling"
      }
    };
    if (apiName) {
      wsdl = wsdl[apiName];
    }
    return wsdl;
  },

  async soap(wsdl, method, args, {headers} = {}) {
    
        let sessionHeaderKey = wsdl.apiName == "Metadata" ? "met:SessionHeader" : "SessionHeader";
        let sessionIdKey = wsdl.apiName == "Metadata" ? "met:sessionId" : "sessionId";
        let requestMethod = wsdl.apiName == "Metadata" ? `met:${method}` : method;
        let requestAttributes = [
          'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
          'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
          'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        ];
        if (wsdl.apiName == "Metadata") {
          requestAttributes.push('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
        }
    
        let requestBody = XML.stringify({
          name: "soapenv:Envelope",
          attributes: ` ${requestAttributes.join(" ")}${wsdl.targetNamespaces}`,
          value: {
            "soapenv:Header": Object.assign({}, {[sessionHeaderKey]: {[sessionIdKey]: this.sessionId}}, headers),
            "soapenv:Body": {[requestMethod]: args}
          }
        });

       const response = await fetch('/api/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: wsdl.servicePortAddress + "?cache=" + Math.random(),
            method: "POST",
            headers: {
                "Content-Type": "text/xml",
                "SOAPAction": '""',
                "CallOptions": `client:${clientId}`
            },
            body: requestBody
          })
       });

       if (!response.ok) {
           console.error("Received error response from Salesforce SOAP Proxy", response);
           let err = new Error();
           err.name = "SalesforceSoapError";
           err.detail = await response.text();
           try {
             let dom = new DOMParser().parseFromString(err.detail, "text/xml");
             err.message = dom.querySelector("faultstring").textContent;
           } catch (ex) {
             err.message = "HTTP error " + response.status + " " + response.statusText;
           }
           throw err;
       }

       let text = await response.text();
       let doc = new DOMParser().parseFromString(text, "text/xml");
       let responseBody = doc.querySelector(method + "Response");
       let parsed = XML.parse(responseBody).result;
       return parsed;
  },

  asArray(x) {
    if (!x) return [];
    if (x instanceof Array) return x;
    return [x];
  },

};

export class XML {
  static stringify({name, attributes, value}) {
    function buildRequest(el, params) {
      if (params == null) {
        el.setAttribute("xsi:nil", "true");
      } else if (typeof params == "object") {
        for (let [key, value] of Object.entries(params)) {
          if (key == "_") {
            if (value == null) {
              el.setAttribute("xsi:nil", "true");
            } else {
              el.textContent = value;
            }
          } else if (key == "$xsi:type") {
            el.setAttribute("xsi:type", value);
          } else if (value === undefined) {
            // ignore
          } else if (Array.isArray(value)) {
            for (let element of value) {
              let x = doc.createElement(key);
              buildRequest(x, element);
              el.appendChild(x);
            }
          } else {
            let x = doc.createElement(key);
            buildRequest(x, value);
            el.appendChild(x);
          }
        }
      } else {
        el.textContent = params;
      }
    }
    let doc = new DOMParser().parseFromString("<" + name + attributes + "/>", "text/xml");
    buildRequest(doc.documentElement, value);
    return '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(doc).replace(/ xmlns=""/g, "");
  }

  static parse(element) {
    function parseResponse(element) {
      let str = ""; // XSD Simple Type value
      let obj = null; // XSD Complex Type value
      // If the element has child elements, it is a complex type. Otherwise we assume it is a simple type.
      if (element.getAttribute("xsi:nil") == "true") {
        return null;
      }
      let type = element.getAttribute("xsi:type");
      if (type) {
        // Salesforce never sets the xsi:type attribute on simple types. It is only used on sObjects.
        obj = {
          "$xsi:type": type
        };
      }
      for (let child = element.firstChild; child != null; child = child.nextSibling) {
        if (child instanceof CharacterData) {
          str += child.data;
        } else if (child instanceof Element) {
          if (obj == null) {
            obj = {};
          }
          let name = child.localName;
          let content = parseResponse(child);
          if (name in obj) {
            if (obj[name] instanceof Array) {
              obj[name].push(content);
            } else {
              obj[name] = [obj[name], content];
            }
          } else {
            obj[name] = content;
          }
        } else {
          throw new Error("Unknown child node type");
        }
      }
      return obj || str;
    }
    return parseResponse(element);
  }
}

function getMyDomain(host) {
  if (host) {
    const myDomain = host
      .replace(/\.lightning\.force\./, ".my.salesforce.") //avoid HTTP redirect (that would cause Authorization header to be dropped)
      .replace(/\.mcas\.ms$/, ""); //remove trailing .mcas.ms if the client uses Microsoft Defender for Cloud Apps
    return myDomain;
  }
  return host;
}

function showToastBanner(){
  const containerToShow = document.getElementById("toastBanner");
  if (containerToShow) { containerToShow.classList.remove("hide"); }
  const containerToMask = document.getElementById("mainTabs");
  if (containerToMask) { containerToMask.classList.add("mask"); }
}
