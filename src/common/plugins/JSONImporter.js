/*globals define*/

define([
    './changeset',
], function(
    diff,
) {
    const Constants = {
        META_ASPECT_SET_NAME: 'MetaAspectSet',
    };

    class Importer {
        constructor(core, rootNode) {
            this.core = core;
            this.rootNode = rootNode;
        }

        async toJSON (node, shallow=false) {
            const json = {
                id: this.core.getGuid(node),
                attributes: {},
                attribute_meta: {},
                pointers: {},
                pointer_meta: {},
                registry: {},
                sets: {},
                member_attributes: {},
                member_registry: {},
                children: [],
            };

            this.core.getOwnAttributeNames(node).forEach(name => {
                json.attributes[name] = this.core.getAttribute(node, name);
            });

            this.core.getOwnValidAttributeNames(node).forEach(name => {
                json.attribute_meta[name] = this.core.getAttributeMeta(node, name);
            });

            this.core.getOwnPointerNames(node).forEach(name => {
                json.pointers[name] = this.core.getPointerPath(node, name);
            });

            this.core.getOwnValidPointerNames(node).forEach(name => {
                json.pointer_meta[name] = this.core.getPointerMeta(node, name);
            });

            this.core.getOwnRegistryNames(node).forEach(name => {
                json.registry[name] = this.core.getRegistry(node, name);
            });

            this.core.getOwnSetNames(node).forEach(name => {
                const members = this.core.getMemberPaths(node, name);
                json.sets[name] = members;

                members.forEach(member => {
                    json.member_attributes[name] = {};
                    json.member_attributes[name][member] = {};

                    this.core.getMemberAttributeNames(node, name, member).forEach(attrName => {
                        const value = this.core.getMemberAttribute(node, name, member, attrName);
                        json.member_attributes[name][member][attrName] = value;
                    });

                    json.member_registry[name] = {};
                    json.member_registry[name][member] = {};
                    this.core.getMemberRegistryNames(node, name, member).forEach(regName => {
                        const value = this.core.getMemberRegistry(node, name, member, regName);
                        json.member_registry[name][member][regName] = value;
                    });
                });
            });

            if (!shallow) {
                const children = await this.core.loadChildren(node);
                for (let i = 0; i < children.length; i++) {
                    json.children.push(await this.toJSON(children[i]));
                }
            }

            return json;
        }

        async apply (node, state) {
            const children = state.children || [];
            const currentChildren = await this.core.loadChildren(node);
            for (let i = 0; i < children.length; i++) {
                const child = (await this.findNode(node, children[i].id)) ||
                    await this.createNode(node, children[i].id);

                const index = currentChildren.indexOf(child);
                if (index > -1) {
                    currentChildren.splice(index, 1);
                }

                await this.apply(child, children[i]);
            }

            const current = await this.toJSON(node);
            const changes = compare(current, state);

            // TODO: Sort the changes? pointer_meta > sets > member_attributes/registry
            for (let i = 0; i < changes.length; i++) {
                if (changes[i].type === 'put') {
                    await this._put(node, changes[i]);
                } else if (changes[i].type === 'del') {
                    await this._delete(node, changes[i]);
                }
            }

            for (let i = currentChildren.length; i--;) {
                this.core.deleteNode(currentChildren[i]);
            }
        }

        async findNode(parent, id) {
            if (id === undefined) {
                return;
            }
            assert(typeof id === 'string');

            const isGMEPath = id.startsWith('/');
            if (isGMEPath) {
                return await this.core.loadByPath(this.rootNode, id);
            }

            const [tag, value] = id.split(':');
            if (tag === '@meta') {
                const meta = await this.core.getAllMetaNodes(this.rootNode);
                return Object.values(meta)
                    .find(child => this.core.getAttribute(child, 'name') === value);
            } else if (tag === '@name') {
                const children = await this.core.loadChildren(parent);
                return children
                    .find(child => this.core.getAttribute(child, 'name') === value);

            } else {
                throw new Error(`Unknown tag: ${tag}`);
            }
        }

        async getNode(parent, id) {
            const node = await this.findNode(parent, id);
            if (!node) {
                throw new Error(`Could not resolve ${id} to an existing node.`);
            }
            return node;
        }

        async getNodeId(parent, id) {
            const node = await this.getNode(parent, id);
            return this.core.getPath(node);
        }

        async createNode(parent, id) {
            const fco = await this.core.loadByPath(this.rootNode, '/1');
            const node = this.core.createNode({base: fco, parent});

            // Apply any special rules based on the tag (name, meta, etc)
            const [tag, value] = id ? id.split(':') : [];
            if (tag === '@name') {
                this.core.setAttribute(node, 'name', value);
            } else if (tag === '@meta') {
                this.core.setAttribute(node, 'name', value);
                this.core.addMember(this.rootNode, Constants.META_ASPECT_SET_NAME, node);
                const meta = await this.core.getAllMetaNodes(this.rootNode);
                assert(meta[this.core.getPath(node)], 'New node not in the meta');
            }

            return node;
        }

        async _put (node, change) {
            const [type] = change.key;
            if (!this._put[type]) {
                throw new Error(`Unrecognized key ${type}`);
            }
            return await this._put[type].call(this, node, change);
        }

        async _delete (node, change) {
            const [type] = change.key;
            if (!this._delete[type]) {
                throw new Error(`Unrecognized key ${type}`);
            }
            if (change.key.length > 1) {
                return await this._delete[type].call(this, node, change);
            }
        }

        async import(parent, state) {
            const node = await this.createNode(parent);
            await this.apply(node, state);
        }
    }

    Importer.prototype._put.attributes = function(node, change) {
        assert(
            change.key.length === 2,
            `Complex attributes not currently supported: ${change.key.join(', ')}`
        );

        const [/*type*/, name] = change.key;
        this.core.setAttribute(node, name, change.value);
    };

    Importer.prototype._delete.attributes = function(node, change) {
        assert(
            change.key.length === 2,
            `Complex attributes not currently supported: ${change.key.join(', ')}`
        );
        const [/*type*/, name] = change.key;
        this.core.delAttribute(node, name);
    };

    Importer.prototype._put.attribute_meta = function(node, change) {
        const [/*type*/, name] = change.key;
        const keys = change.key.slice(2);
        if (keys.length) {
            const value = this.core.getAttributeMeta(node, name);
            setNested(value, keys, change.value);
            this.core.setAttributeMeta(node, name, value);
        } else {
            this.core.setAttributeMeta(node, name, change.value);
        }
    };

    Importer.prototype._delete.attribute_meta = function(node, change) {
        assert(
            change.key.length === 2,
            `Nested values not supported for attribute meta: ${change.key.slice(1).join(', ')}`
        );
        const [/*type*/, name] = change.key;
        this.core.delAttributeMeta(node, name);
    };

    Importer.prototype._put.pointers = async function(node, change) {
        assert(
            change.key.length === 2,
            `Invalid key for pointer: ${change.key.slice(1).join(', ')}`
        );
        const [/*type*/, name] = change.key;
        const target = await this.getNode(node, change.value);
        this.core.setPointer(node, name, target);
    };

    Importer.prototype._delete.pointers = function(node, change) {
        assert(
            change.key.length === 2,
            `Invalid key for pointer: ${change.key.slice(1).join(', ')}`
        );
        const [/*type*/, name] = change.key;
        this.core.delPointer(node, name);
    };

    Importer.prototype._put.pointer_meta = async function(node, change) {
        const [/*"pointer_meta"*/, name, idOrMinMax] = change.key;
        const isNewPointer = change.key.length === 2;

        if (isNewPointer) {
            const meta = change.value;
            this.core.setPointerMetaLimits(node, name, meta.min, meta.max);

            const targets = Object.entries(change.value)
                .filter(pair => {
                    const [key, /*value*/] = pair;
                    return !['min', 'max'].includes(key);
                });

            for (let i = targets.length; i--;) {
                const [nodeId, meta] = targets[i];
                const target = await this.getNode(node, nodeId);
                this.core.setPointerMetaTarget(node, name, target, meta.min, meta.max);
            }
        } else if (['min', 'max'].includes(idOrMinMax)) {
            const meta = this.core.getPointerMeta(node, name);
            meta[idOrMinMax] = change.value;
            this.core.setPointerMetaLimits(node, name, meta.min, meta.max);
        } else {
            const meta = this.core.getPointerMeta(node, name);
            setNested(meta, change.key.slice(2), change.value);

            const targetMeta = meta[idOrMinMax];
            const target = await this.getNode(node, idOrMinMax);
            this.core.setPointerMetaTarget(node, name, target, targetMeta.min, targetMeta.max);
        }
    };

    Importer.prototype._delete.pointer_meta = function(node, change) {
        const [/*type*/, name, targetId] = change.key;
        const removePointer = targetId === undefined;
        if (removePointer) {
            this.core.delPointerMeta(node, name);
        } else {
            this.core.delPointerMetaTarget(node, name, targetId);
        }
    };

    Importer.prototype._put.sets = async function(node, change) {
        const [/*type*/, name] = change.key;
        const isNewSet = change.key.length === 2;
        if (isNewSet) {
            this.core.createSet(node, name);
            const memberPaths = change.value;

            for (let i = 0; i < memberPaths.length; i++) {
                const member = await this.getNode(node, memberPaths[i]);
                this.core.addMember(node, name, member);
            }
        } else {
            const member = await this.getNode(node, change.value);
            this.core.addMember(node, name, member);
        }
    };

    Importer.prototype._delete.sets = async function(node, change) {
        const [/*type*/, name, index] = change.key;
        const removeSet = index === undefined;
        if (removeSet) {
            this.core.delSet(node, name);
        } else {
            const member = this.core.getMemberPaths(node, name)[index];
            this.core.delMember(node, name, member);
        }
    };

    Importer.prototype._put.member_attributes = async function(node, change) {
        const [/*type*/, set, nodeId, name] = change.key;
        const isNewSet = nodeId === undefined;
        const isNewMember = name === undefined;
        if (isNewSet || isNewMember) {
            const changesets = Object.entries(change.value)
                .map(entry => ({
                    type: 'put',
                    key: change.key.concat([entry[0]]),
                    value: entry[1],
                }));

            for (let i = changesets.length; i--;) {
                await this._put(node, changesets[i]);
            }
        } else {
            const gmeId = await this.getNodeId(node, nodeId);
            this.core.setMemberAttribute(node, set, gmeId, name, change.value);
        }
    };

    Importer.prototype._delete.member_attributes = function(node, change) {
        const [/*type*/, set, nodeId, name] = change.key;
        const deleteAllAttributes = name === undefined;
        const attributeNames = deleteAllAttributes ?
            this.core.getMemberAttributeNames(node, set, nodeId) : [name];

        attributeNames.forEach(name => {
            this.core.delMemberAttribute(node, set, nodeId, name);
        });
    };

    Importer.prototype._put.member_registry = async function(node, change) {
        const [/*type*/, set, nodeId, name] = change.key;
        const isNewSet = nodeId === undefined;
        const isNewMember = name === undefined;
        if (isNewSet || isNewMember) {
            const changesets = Object.entries(change.value)
                .map(entry => ({
                    type: 'put',
                    key: change.key.concat([entry[0]]),
                    value: entry[1],
                }));

            for (let i = changesets.length; i--;) {
                await this._put(node, changesets[i]);
            }
        } else {
            const gmeId = await this.getNodeId(node, nodeId);
            const isNested = change.key.length > 4;
            if (isNested) {
                const value = this.core.getMemberRegistry(node, set, gmeId, name);
                setNested(value, change.key.slice(4), change.value);
                this.core.setMemberRegistry(node, set, gmeId, name, value);
            } else {
                this.core.setMemberRegistry(node, set, gmeId, name, change.value);
            }
        }
    };

    Importer.prototype._delete.member_registry = function(node, change) {
        const [/*type*/, set, nodeId, name] = change.key;
        const deleteAllRegistryValues = name === undefined;
        const attributeNames = deleteAllRegistryValues ?
            this.core.getMemberRegistryNames(node, set, nodeId) : [name];

        attributeNames.forEach(name => {
            this.core.delMemberRegistry(node, set, nodeId, name);
        });
    };

    Importer.prototype._put.registry = function(node, change) {
        const [/*type*/, name] = change.key;
        const keys = change.key.slice(2);
        if (keys.length) {
            const value = this.core.getRegistry(node, name);
            setNested(value, keys, change.value);
            this.core.setRegistry(node, name, value);
        } else {
            this.core.setRegistry(node, name, change.value);
        }
    };

    Importer.prototype._delete.registry = function(node, change) {
        assert(
            change.key.length === 2,
            `Complex registry values not currently supported: ${change.key.join(', ')}`
        );
        const [/*type*/, name] = change.key;
        this.core.delRegistry(node, name);
    };

    function omit(obj, keys) {
        const result = Object.assign({}, obj);
        keys.forEach(key => delete result[key]);
        return result;
    }

    function compare(obj, obj2, ignore=['id', 'children']) {
        return diff(
            omit(obj, ignore),
            omit(obj2, ignore),
        );
    }

    function assert(cond, msg='ASSERT failed') {
        if (!cond) {
            throw new Error(msg);
        }
    }

    function setNested(object, keys, value) {
        let current = object;
        while (keys.length > 1) {
            current = current[keys.shift()];
        }
        current[keys.shift()] = value;
        return object;
    }

    return Importer;
});
