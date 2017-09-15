const {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLInt,
  GraphQLNonNull
} = require('graphql')
const {
  resolver,
  attributeFields,
  defaultListArgs,
  defaultArgs,
  JSONType
} = require('graphql-sequelize')

/**
 * Returns the association fields of an entity.
 *
 * It iterates over all the associations and produces an object compatible with GraphQL-js.
 * BelongsToMany and HasMany associations are represented as a `GraphQLList` whereas a BelongTo
 * is simply an instance of a type.
 * @param {*} associations A collection of sequelize associations
 * @param {*} types Existing `GraphQLObjectType` types, created from all the Sequelize models
 */
const generateAssociationFields = (associations, types, isInput = false) => {
  let fields = {}
  for (let associationName in associations) {
    const relation = associations[associationName]
    // BelongsToMany is represented as a list, just like HasMany
    const type = relation.associationType === 'BelongsToMany' ||
      relation.associationType === 'HasMany'
      ? new GraphQLList(types[relation.target.name])
      : types[relation.target.name]

    fields[associationName] = {
      type
    }
    if (!isInput) {
      // GraphQLInputObjectType do not accept fields with resolve
      fields[associationName].resolve = resolver(relation)
    }
  }
  return fields
}

/**
 * Returns a new `GraphQLObjectType` created from a sequelize model.
 *
 * It creates a `GraphQLObjectType` object with a name and fields. The
 * fields are generated from its sequelize associations.
 * @param {*} model The sequelize model used to create the `GraphQLObjectType`
 * @param {*} types Existing `GraphQLObjectType` types, created from all the Sequelize models
 */
const generateGraphQLType = (model, types, isInput = false) => {
  const GraphQLClass = isInput ? GraphQLInputObjectType : GraphQLObjectType
  return new GraphQLClass({
    name: isInput ? `${model.name}Input` : model.name,
    fields: () =>
      Object.assign(
        attributeFields(model, {
          allowNull: !!isInput
        }),
        generateAssociationFields(model.associations, types, isInput)
      )
  })
}

/**
 * Returns a collection of `GraphQLObjectType` generated from Sequelize models.
 *
 * It creates an object whose properties are `GraphQLObjectType` created
 * from Sequelize models.
 * @param {*} models The sequelize models used to create the types
 */
// This function is exported
const generateModelTypes = models => {
  let outputTypes = {}
  let inputTypes = {}
  for (let modelName in models) {
    // Only our models, not Sequelize nor sequelize
    if (models[modelName].hasOwnProperty('name') && modelName !== 'Sequelize') {
      outputTypes[modelName] = generateGraphQLType(
        models[modelName],
        outputTypes
      )
      inputTypes[modelName] = generateGraphQLType(
        models[modelName],
        inputTypes,
        true
      )
    }
  }
  return {outputTypes, inputTypes}
}

/**
 * Returns a root `GraphQLObjectType` used as query for `GraphQLSchema`.
 *
 * It creates an object whose properties are `GraphQLObjectType` created
 * from Sequelize models.
 * @param {*} models The sequelize models used to create the root `GraphQLSchema`
 */
const generateQueryRootType = (models, outputTypes, options) => {
  return new GraphQLObjectType({
    name: 'Root_Query',
    fields: Object.keys(outputTypes).reduce(
      (fields, modelTypeName) => {
        const modelType = outputTypes[modelTypeName]
        return Object.assign(fields, {
          [modelType.name]: {
            type: new GraphQLList(modelType),
            args: Object.assign(
              defaultArgs(models[modelType.name]),
              defaultListArgs()
            ),
            resolve: resolver(models[modelType.name], {
              after: (results) => {
                options.logging(`Results: ${JSON.stringify(results, null, 2)}`);
                return results;
              }
            })
          }
        })
      },
      options.custom || {}
    )
  })
}

const generateMutationRootType = (models, inputTypes, outputTypes, options) => {
  return new GraphQLObjectType({
    name: 'Root_Mutations',
    fields: Object.keys(inputTypes).reduce(
      (fields, inputTypeName) => {
        const inputType = inputTypes[inputTypeName]
        const key = models[inputTypeName].primaryKeyAttributes[0]
        if (models[inputTypeName].options.readOnly) {
          return Object.assign(fields, {});
        }
        if (!models[inputTypeName].authorize) {
          models[inputTypeName].authorize = function() {
            return new Promise((resolve, reject) => {
              resolve(true);
            })
          }
        }
        const toReturn = Object.assign(fields, models[inputTypeName].options.updateOnly ? {} : {
          [inputTypeName + 'Create']: {
            type: outputTypes[inputTypeName], // what is returned by resolve, must be of type GraphQLObjectType
            description: 'Create a ' + inputTypeName,
            args: {
              [inputTypeName]: {type: inputType}
            },
            resolve: (source, args, context, info) => {
              return models[inputTypeName].authorize(args, context)
                .then((result) => {
                  return models[inputTypeName].create(args[inputTypeName])
                }).then((result) => {
                  options.logging(`Results: ${JSON.stringify(results, null, 2)}`);
                  return result;
                })
            }
          },
          [inputTypeName + 'ListCreate']: {
            type: new GraphQLList(outputTypes[inputTypeName]), // what is returned by resolve, must be of type GraphQLObjectType
            description: 'Create a list of ' + inputTypeName,
            args: {
              [inputTypeName]: {type: new GraphQLList(inputType)}
            },
            resolve: (source, args, context, info) => {
              return models[inputTypeName].authorize(args, context)
                .then((result) => {
                  return models[inputTypeName].bulkCreate(args[inputTypeName])
                }).then((result) => {
                  options.logging(`Results: ${JSON.stringify(results, null, 2)}`);
                  return result;
                });
            }
          },
        }, {
          [inputTypeName + 'Update']: {
            type: outputTypes[inputTypeName],
            description: 'Update a ' + inputTypeName,
            args: {
              [inputTypeName]: {type: inputType},
              where: {type: JSONType.default}
            },
            resolve: (source, args, context, info) => {
              const where = (args['where']) ? args['where'] : { [key]: args[inputTypeName][key] }
              const resolveWhere = (args['where']) ? Object.assign({}, where, args[inputTypeName]) : where
              return models[inputTypeName].authorize(args, context)
                .then((result) => {
                  return models[inputTypeName].update(args[inputTypeName], { where })
                })
                .then(boolean => {
                  // `boolean` equals the number of rows affected (0 or 1)
                  return resolver(models[inputTypeName], {
                    after: (results) => {
                      options.logging(`Results: ${JSON.stringify(results, null, 2)}`);
                      return results;
                    }
                  })(source, resolveWhere, context, info)
                })
            }
          },
        }, models[inputTypeName].options.updateOnly ? {} : {
          [inputTypeName + 'Delete']: {
            type: GraphQLInt,
            description: 'Delete a ' + inputTypeName,
            args: {
              [key]: {type: GraphQLInt},
              where: {type: JSONType.default}
            },
            resolve: (value, args, context, info) => {
              let where = {};
              if (args['where']) where = args['where'];
              else if (args[key]) where = { [key]: args[key] };
              return models[inputTypeName].authorize(args, context)
                .then((result) => {
                  models[inputTypeName].destroy({ where }) // Returns the number of rows affected (0 or more)
                });
            }
          }
        })
        return toReturn
      },
      {}
    )
  })
}

// This function is exported
const generateSchema = (models, types, options) => {
  options = options || {};

  const loggging = (typeof options.logging === 'function') ? options.logging : (msg) => undefined;
  const modelTypes = types || generateModelTypes(models)
  return {
    query: generateQueryRootType(models, modelTypes.outputTypes, options),
    mutation: generateMutationRootType(
      models,
      modelTypes.inputTypes,
      modelTypes.outputTypes,
      options
    )
  }
}

module.exports = {
  generateGraphQLType,
  generateModelTypes,
  generateSchema
}
