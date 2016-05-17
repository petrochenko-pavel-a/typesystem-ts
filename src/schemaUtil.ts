/// <reference path="../typings/main.d.ts" />
declare function require(s:string):any;

import _ = require("./utils");

import xmlValidator = require('./xmlUtil');

var DOMParser = require('xmldom').DOMParser;
var ZSchema=require("z-schema");

export class ValidationResult{
    result:any;
    num:number;
}

var useLint=true;

class ErrorsCache {
    errors: any = {};

    getValue(key: any): any {
        return <any>this.errors[key];
    }

    setValue(key: any, value: any) {
        this.errors[key] = value;
    }
}

var globalCache = new ErrorsCache();

export interface Promise {
    then(instance: any): any;

    resolve(arg: any): any;
}

export interface IContentProvider {
    contextPath(): string;

    normalizePath(url: string): string;

    content(reference: string): string;

    hasAsyncRequests(): boolean;

    resolvePath(context: string, relativePath: string): string;

    isAbsolutePath(uri: string): boolean;

    contentAsync(arg: any): Promise;

    promiseResolve(arg: any): Promise;
}

class DummyProvider implements  IContentProvider {
    contextPath(): string {
        return "";
    }

    normalizePath(url: string): string {
        return "";
    }

    content(reference: string): string {
        return "";
    }

    hasAsyncRequests(): boolean {
        return false;
    }

    resolvePath(context: string, relativePath: string): string {
        return "";
    }

    isAbsolutePath(uri: string): boolean {
        return false;
    }

    contentAsync(reference: string): Promise {
        return {
            then: arg => arg(this.content(reference)),

            resolve: () => null
        };
    }

    promiseResolve(arg: any): Promise {
        return {
            then: arg1 => arg1(arg),

            resolve: () => null
        }
    }
}

export class JSONSchemaObject {
    jsonSchema: any;

    constructor(private schema:string, private provider: IContentProvider){
        if(!provider) {
            this.provider = new DummyProvider();
        } else {
            this.provider = provider;
        }

        if(!schema||schema.trim().length==0||schema.trim().charAt(0)!='{'){
            throw new Error("Invalid JSON schema content");
        }

        var jsonSchemaObject: any;

        try {
            var jsonSchemaObject = JSON.parse(schema);
        } catch(err){
            throw new Error("It is not JSON schema(can not parse JSON:"+err.message+")");
        }

        if(!jsonSchemaObject){
            return
        }

        try{
            var api: any = require('json-schema-compatibility');

            this.setupId(jsonSchemaObject, this.provider.contextPath());

            jsonSchemaObject =api.v4(jsonSchemaObject);
        } catch (e){
            throw new Error('Can not parse schema'+schema)
        }

        delete jsonSchemaObject['$schema']

        this.jsonSchema=jsonSchemaObject;
    }

    getType() : string {
        return "source.json";
    }

    validateObject (object:any): any{
        //TODO Validation of objects
        //xmlutil(content);
        this.validate(JSON.stringify(object));
    }

    getMissingReferences(references: any[], normalize: boolean = false): any[] {
        var result: any[] = [];

        var validator = new ZSchema();

        references.forEach(references => validator.setRemoteReference(references.reference, references.content || {}));

        try {
            validator.validateSchema(this.jsonSchema);
        } catch (Error) {
            //we should never be exploding here, instead we'll report this error later
            return []
        }

        var result = <any[]>validator.getMissingRemoteReferences();

        return normalize ? result.map(reference => this.provider.normalizePath(reference)) : result;
    }

    private getSchemaPath(schema: any, normalize: boolean = false): string {
        if(!schema) {
            return "";
        }

        if(!schema.id) {
            return "";
        }

        var id = schema.id.trim();

        if(!(id.lastIndexOf('#') === id.length - 1)) {
            return id;
        }

        var result =  id.substr(0, id.length -1);

        if(!normalize) {
            return result;
        }

        return this.provider.normalizePath(result);
    }

    private patchSchema(schema: any): any {
        if(!schema) {
            return schema;
        }

        if(!schema.id) {
            return schema;
        }

        var id = schema.id.trim();

        if(!(id.lastIndexOf('#') === id.length - 1)) {
            id = id + '#';

            schema.id = id;
        };

        var currentPath = id.substr(0, id.length -1);

        if(!this.provider.isAbsolutePath(currentPath)) {
            return schema;
        }

        currentPath = this.provider.normalizePath(currentPath);

        var refContainers: any[] = [];

        this.collectRefContainers(schema, refContainers);

        refContainers.forEach(refConatiner => {
            var reference = refConatiner['$ref'];

            if(typeof reference !== 'string') {
                return;
            }

            if(reference.indexOf('#') === 0) {
                return;
            }

            if(reference.indexOf('#') === -1) {
                reference = reference + '#';
            }

            if(!this.provider.isAbsolutePath(reference)) {
                refConatiner['$ref'] = this.provider.resolvePath(currentPath, reference).replace(/\\/g,'/');
            }
        });
    }

    private collectRefContainers(rootObject: any, refContainers: any): void {
        Object.keys(rootObject).forEach(key => {
            if(key === '$ref') {
                refContainers.push(rootObject);

                return;
            }

            if(!rootObject[key]) {
                return;
            }

            if(typeof rootObject[key] === 'object') {
                this.collectRefContainers(rootObject[key], refContainers);
            }
        });
    }

    validate(content: any, alreadyAccepted: any[] = []): void {
        var key = content + this.schema + this.provider.contextPath();

        var error = globalCache.getValue(key);

        if(error) {
            if(error instanceof Error) {
                throw error;
            }

            return;
        }

        var validator = new ZSchema();

        alreadyAccepted.forEach(accepted => validator.setRemoteReference(accepted.reference, accepted.content));

        validator.validate(JSON.parse(content), this.jsonSchema);

        var missingReferences = validator.getMissingRemoteReferences().filter((reference: any) => !_.find(alreadyAccepted, (acceptedReference: any) => reference === acceptedReference.reference));

        if(!missingReferences || missingReferences.length === 0) {
            this.acceptErrors(key, validator.getLastErrors(), true);

            return;
        }

        var acceptedReferences: any = [];

        missingReferences.forEach((reference: any) => {
            var remoteSchemeContent: any;

            var result: any = {reference: reference};

            try {
                var api = require('json-schema-compatibility');

                var jsonObject = JSON.parse(this.provider.content(reference));

                this.setupId(jsonObject, this.provider.normalizePath(reference));

                remoteSchemeContent = api.v4(jsonObject);

                delete remoteSchemeContent['$schema'];

                result.content = remoteSchemeContent;
            } catch(exception){
                result.error = exception;
            } finally {
                acceptedReferences.push(result);
            }
        });

        if(this.provider.hasAsyncRequests()) {
            return;
        }

        acceptedReferences.forEach((accepted: any) => {
            alreadyAccepted.push(accepted);
        });

        this.validate(content, alreadyAccepted);
    }

    private setupId(json: any, path: string): any {
        if(!path) {
            return;
        }

        if(!json) {
            return;
        }

        if(json.id) {
            return;
        }

        json.id = path.replace(/\\/g,'/') + '#';

        this.patchSchema(json);
    }

    private acceptErrors(key: any, errors: any[], throwImmediately = false): void {
        if(errors && errors.length>0){
            var res= new Error("Content is not valid according to schema:"+errors.map(x=>x.message+" "+x.params).join(", "));

            (<any>res).errors=errors;

            globalCache.setValue(key, res);

            if(throwImmediately) {
                throw res;
            }

            return;
        }

        globalCache.setValue(key, 1);
    }

    contentAsync(reference: any): Promise {
        var remoteSchemeContent: any;

        var api: any = require('json-schema-compatibility');

        var contentPromise = this.provider.contentAsync(reference);

        if(!contentPromise) {
            return this.provider.promiseResolve({
                reference: reference,
                content: null,
                error: new Error('Reference not found: ' + reference)
            });
        }

        var result = contentPromise.then((cnt: any) => {
            var content: any = {reference: reference};

            try {
                var jsonObject = JSON.parse(cnt);

                this.setupId(jsonObject, this.provider.normalizePath(reference));

                remoteSchemeContent = api.v4(jsonObject);

                delete remoteSchemeContent['$schema'];

                content.content = remoteSchemeContent;
            } catch(exception) {
                content.error = exception;
            }

            return content;
        });

        return result;
    }
}
export interface ValidationError{
    code:string
    params:string[]
    message:string
    path:string
}

export class XMLSchemaObject {
    private schemaObj: xmlValidator.XMLValidator;

    private extraElementData: any = null;

    constructor(private schema:string){
        if(schema.charAt(0)!='<'){
            throw new Error("Invalid JSON schema")
        }

        this.schemaObj = new xmlValidator.XMLValidator(this.handleReferenceElement(schema));
    }

    getType() : string {
        return "text.xml";
    }

    validateObject(object:any): any {
        if(this.extraElementData) {
            var objectName = Object.keys(object)[0];

            if(!this.extraElementData.type && !this.extraElementData.originalName) {
                this.acceptErrors("key", [new Error('Referenced type "' + this.extraElementData.requestedName + '" is not match with "' + objectName + '" root node')], true);

                return;
            }

            if(this.extraElementData.originalName && objectName !== this.extraElementData.originalName) {
                this.acceptErrors("key", [new Error('Referenced type "' + this.extraElementData.requestedName + '" is not match with "' + objectName + '" root node')], true);

                return;
            }

            if(this.extraElementData.type) {
                var root = object[objectName];

                delete object[objectName];

                object[this.extraElementData.name] = root;
            }
        }
        
        this.validate(xmlValidator.jsonToXml(object));
    }

    validate(xml: any) {
        var validationErrors = this.schemaObj.validate(xml);
        
        this.acceptErrors("key", validationErrors, true);
    }

    private handleReferenceElement(content: string): string {
        var doc = new DOMParser().parseFromString(content);

        var schema = elementChildrenByName(doc, 'xs:schema')[0];

        var elements:any[] = elementChildrenByName(schema, 'xs:element');

        var element = _.find(elements, (element:any) => element.getAttribute('extraelement') === 'true');

        if(!element) {
            return content;
        }

        var extraElementData: any = {};

        extraElementData.name = element.getAttribute('name');
        extraElementData.type = element.getAttribute('type');
        extraElementData.originalName = element.getAttribute('originalname');
        extraElementData.requestedName = element.getAttribute('requestedname');

        if(!extraElementData.type) {
            schema.removeChild(element);
        }

        element.removeAttribute('originalname');
        element.removeAttribute('requestedname');
        element.removeAttribute('extraelement');

        this.extraElementData = extraElementData;

        return doc.toString();
    }
    
    private acceptErrors(key: any, errors: any[], throwImmediately = false): void {
        if(errors && errors.length>0){
            var res= new Error("Content is not valid according to schema:"+errors.map(x=>x.message).join(", "));

            (<any>res).errors=errors;

            globalCache.setValue(key, res);

            if(throwImmediately) {
                throw res;
            }

            return;
        }
    }
}
export interface Schema {
    getType(): string;
    validate(content: string): void;
    validateObject(object:any):void;
}
export function getJSONSchema(content: string, provider: IContentProvider) {
    var rs = useLint ? globalCache.getValue(content) : false;
    if (rs && rs.provider) {
        return rs;
    }
    var res = new JSONSchemaObject(content, provider);
    globalCache.setValue(content, res);
    return res;
}

export function getXMLSchema(content: string) {
    var rs = useLint ? globalCache.getValue(content) : false;
    if (rs) {
        return rs;
    }
    var res = new XMLSchemaObject(content);

    if (useLint) {
        globalCache.setValue(content, res);
    }

    return res;
}

export function createSchema(content: string, provider: IContentProvider): Schema {

    var rs = useLint ? globalCache.getValue(content) : false;
    if (rs) {
        return rs;
    }
    try {
        var res: Schema = new JSONSchemaObject(content, provider);
        if (useLint) {
            globalCache.setValue(content, res);
        }
        return res;
    }
    catch (e) {
        try {
            var res: Schema = new XMLSchemaObject(content);
            if (useLint) {
                globalCache.setValue(content, res);
            }
            return res;
        }
        catch (e) {
            if (useLint) {
                globalCache.setValue(content, new Error("Can not parse schema"))
            }
            return null;
        }
    }
}

function elementChildrenByName(parent: any, tagName: string): any[] {
    var elements = parent.getElementsByTagName(tagName);

    var result: any[] = [];

    for(var i: number = 0; i < elements.length; i++) {
        var child = elements[i];

        if(child.parentNode === parent) {
            result.push(child);
        }
    }

    return result;
}