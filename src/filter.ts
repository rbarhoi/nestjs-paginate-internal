import { values } from 'lodash'
import {
    ArrayContains,
    Between,
    Brackets,
    Equal,
    FindOperator,
    ILike,
    In,
    IsNull,
    JsonContains,
    LessThan,
    LessThanOrEqual,
    MoreThan,
    MoreThanOrEqual,
    Not,
    SelectQueryBuilder,
} from 'typeorm'
import { WherePredicateOperator } from 'typeorm/query-builder/WhereClause'
import { PaginateQuery } from './decorator'
import {
    checkIsArray,
    checkIsEmbedded,
    checkIsJsonb,
    checkIsNestedRelation,
    checkIsRelation,
    extractVirtualProperty,
    fixColumnAlias,
    getPropertiesByColumnName,
    isDateColumnType,
    isISODate,
    JoinMethod,
} from './helper'

export enum FilterOperator {
    EQ = '$eq',
    GT = '$gt',
    GTE = '$gte',
    IN = '$in',
    NULL = '$null',
    LT = '$lt',
    LTE = '$lte',
    BTW = '$btw',
    ILIKE = '$ilike',
    SW = '$sw',
    CONTAINS = '$contains',
    NEQ = '$neq',
    NINC = '$ninc',
    NCONTAINS = '$ncontains',
}

export function isOperator(value: unknown): value is FilterOperator {
    return values(FilterOperator).includes(value as any)
}

export enum FilterSuffix {
    NOT = '$not',
}

export function isSuffix(value: unknown): value is FilterSuffix {
    return values(FilterSuffix).includes(value as any)
}

export enum FilterComparator {
    AND = '$and',
    OR = '$or',
}

export function isComparator(value: unknown): value is FilterComparator {
    return values(FilterComparator).includes(value as any)
}

export const OperatorSymbolToFunction = new Map<
    FilterOperator | FilterSuffix,
    (...args: any[]) => FindOperator<string>
>([
    [FilterOperator.EQ, Equal],
    [FilterOperator.GT, MoreThan],
    [FilterOperator.GTE, MoreThanOrEqual],
    [FilterOperator.IN, In],
    [FilterOperator.NULL, IsNull],
    [FilterOperator.LT, LessThan],
    [FilterOperator.LTE, LessThanOrEqual],
    [FilterOperator.BTW, Between],
    [FilterOperator.ILIKE, ILike],
    [FilterSuffix.NOT, Not],
    [FilterOperator.SW, ILike],
    [FilterOperator.CONTAINS, ArrayContains],
    [FilterOperator.NCONTAINS, (v: any) => Not(ArrayContains(v))],
    [FilterOperator.NINC, (v: string) => Not(ILike(`%${v}%`))],
    [FilterOperator.NEQ, (v: any) => Not(Equal(v))],
])

type Filter = { comparator: FilterComparator; findOperator: FindOperator<string> }
type ColumnFilters = { [columnName: string]: Filter[] }
type ColumnJoinMethods = { [columnName: string]: JoinMethod }

export interface FilterToken {
    comparator: FilterComparator
    suffix?: FilterSuffix
    operator: FilterOperator
    value: string
}

// This function is used to fix the query parameters when using relation, embeded or virtual properties
// It will replace the column name with the alias name and return the new parameters
export function fixQueryParam(
    alias: string,
    column: string,
    filter: Filter,
    condition: WherePredicateOperator,
    parameters: { [key: string]: string }
): { [key: string]: string } {
    const isNotOperator = (condition.operator as string) === 'not'

    const conditionFixer = (
        alias: string,
        column: string,
        filter: Filter,
        operator: WherePredicateOperator['operator'],
        parameters: { [key: string]: string }
    ): { condition_params: any; params: any } => {
        let condition_params: any = undefined
        let params = parameters
        switch (operator) {
            case 'between':
                condition_params = [alias, `:${column}_from`, `:${column}_to`]
                params = {
                    [column + '_from']: filter.findOperator.value[0],
                    [column + '_to']: filter.findOperator.value[1],
                }
                break
            case 'in':
                condition_params = [alias, `:...${column}`]
                break
            default:
                condition_params = [alias, `:${column}`]
                break
        }
        return { condition_params, params }
    }

    const { condition_params, params } = conditionFixer(
        alias,
        column,
        filter,
        isNotOperator ? condition['condition']['operator'] : condition.operator,
        parameters
    )

    if (isNotOperator) {
        condition['condition']['parameters'] = condition_params
    } else {
        condition.parameters = condition_params
    }

    return params
}

export function generatePredicateCondition(
    qb: SelectQueryBuilder<unknown>,
    column: string,
    filter: Filter,
    alias: string,
    isVirtualProperty = false
): WherePredicateOperator {
    return qb['getWherePredicateCondition'](
        isVirtualProperty ? column : alias,
        filter.findOperator
    ) as WherePredicateOperator
}

export function addWhereCondition<T>(qb: SelectQueryBuilder<T>, column: string, filter: ColumnFilters) {
    const columnProperties = getPropertiesByColumnName(column)
    const { isVirtualProperty, query: virtualQuery } = extractVirtualProperty(qb, columnProperties)
    const isRelation = checkIsRelation(qb, columnProperties.propertyPath)
    const isEmbedded = checkIsEmbedded(qb, columnProperties.propertyPath)
    const isArray = checkIsArray(qb, columnProperties.propertyName)

    const alias = fixColumnAlias(columnProperties, qb.alias, isRelation, isVirtualProperty, isEmbedded, virtualQuery)
    filter[column].forEach((columnFilter: Filter, index: number) => {
        const columnNamePerIteration = `${columnProperties.column}${index}`
        const condition = generatePredicateCondition(
            qb,
            columnProperties.column,
            columnFilter,
            alias,
            isVirtualProperty
        )
        const parameters = fixQueryParam(alias, columnNamePerIteration, columnFilter, condition, {
            [columnNamePerIteration]: columnFilter.findOperator.value,
        })
        if (
            isArray &&
            condition.parameters?.length &&
            !['not', 'isNull', 'arrayContains'].includes(condition.operator)
        ) {
            condition.parameters[0] = `cardinality(${condition.parameters[0]})`
        }
        if (columnFilter.comparator === FilterComparator.OR) {
            qb.orWhere(qb['createWhereConditionExpression'](condition), parameters)
        } else {
            qb.andWhere(qb['createWhereConditionExpression'](condition), parameters)
        }
    })
}

export function parseFilterToken(raw?: string): FilterToken | null {
    if (raw === undefined || raw === null) {
        return null
    }

    const token: FilterToken = {
        comparator: FilterComparator.AND,
        suffix: undefined,
        operator: FilterOperator.EQ,
        value: raw,
    }

    const MAX_OPERTATOR = 4 // max 4 operator es: $and:$not:$eq:$null
    const OPERAND_SEPARATOR = ':'

    const matches = raw.split(OPERAND_SEPARATOR)
    const maxOperandCount = matches.length > MAX_OPERTATOR ? MAX_OPERTATOR : matches.length
    const notValue: (FilterOperator | FilterSuffix | FilterComparator)[] = []

    for (let i = 0; i < maxOperandCount; i++) {
        const match = matches[i]
        if (isComparator(match)) {
            token.comparator = match
        } else if (isSuffix(match)) {
            token.suffix = match
        } else if (isOperator(match)) {
            token.operator = match
        } else {
            break
        }
        notValue.push(match)
    }

    if (notValue.length) {
        token.value =
            token.operator === FilterOperator.NULL
                ? undefined
                : raw.replace(`${notValue.join(OPERAND_SEPARATOR)}${OPERAND_SEPARATOR}`, '')
    }

    return token
}

function fixColumnFilterValue<T>(column: string, qb: SelectQueryBuilder<T>, isJsonb = false) {
    const columnProperties = getPropertiesByColumnName(column)
    const virtualProperty = extractVirtualProperty(qb, columnProperties)
    const columnType = virtualProperty.type

    return (value: string) => {
        if ((isDateColumnType(columnType) || isJsonb) && isISODate(value)) {
            return new Date(value)
        }

        if ((columnType === Number || isJsonb) && !Number.isNaN(value)) {
            return Number(value)
        }

        return value
    }
}

export function parseFilter<T>(
    query: PaginateQuery,
    filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true },
    qb?: SelectQueryBuilder<T>
): ColumnFilters {
    const filter: ColumnFilters = {}
    if (!filterableColumns || !query.filter) {
        return {}
    }
    for (const column of Object.keys(query.filter)) {
        if (!(column in filterableColumns)) {
            continue
        }
        const allowedOperators = filterableColumns[column]
        const input = query.filter[column]
        const statements = !Array.isArray(input) ? [input] : input
        for (const raw of statements) {
            const token = parseFilterToken(raw)
            if (!token) {
                continue
            }
            if (allowedOperators === true) {
                if (token.operator && !isOperator(token.operator)) {
                    continue
                }
                if (token.suffix && !isSuffix(token.suffix)) {
                    continue
                }
            } else {
                if (
                    token.operator &&
                    token.operator !== FilterOperator.EQ &&
                    !allowedOperators.includes(token.operator)
                ) {
                    continue
                }
                if (token.suffix && !allowedOperators.includes(token.suffix)) {
                    continue
                }
            }

            const params: (typeof filter)[0][0] = {
                comparator: token.comparator,
                findOperator: undefined,
            }

            const fixValue = fixColumnFilterValue(column, qb)

            const columnProperties = getPropertiesByColumnName(column)
            const isJsonb = checkIsJsonb(qb, columnProperties.column)

            switch (token.operator) {
                case FilterOperator.BTW:
                    params.findOperator = OperatorSymbolToFunction.get(token.operator)(
                        ...token.value.split(',').map(fixValue)
                    )
                    break
                case FilterOperator.IN:
                case FilterOperator.CONTAINS:
                    params.findOperator = OperatorSymbolToFunction.get(token.operator)(token.value.split(','))
                    break
                case FilterOperator.ILIKE:
                    params.findOperator = OperatorSymbolToFunction.get(token.operator)(`%${token.value}%`)
                    break
                case FilterOperator.SW:
                    params.findOperator = OperatorSymbolToFunction.get(token.operator)(`${token.value}%`)
                    break
                default:
                    params.findOperator = OperatorSymbolToFunction.get(token.operator)(fixValue(token.value))
            }

            if (isJsonb) {
                const parts = column.split('.')
                const dbColumnName = parts[parts.length - 2]
                const jsonColumnName = parts[parts.length - 1]

                const jsonFixValue = fixColumnFilterValue(column, qb, true)

                const jsonParams = {
                    comparator: params.comparator,
                    findOperator: JsonContains({
                        [jsonColumnName]: jsonFixValue(token.value),
                        //! Below seems to not be possible from my understanding, https://github.com/typeorm/typeorm/pull/9665
                        //! This limits the functionaltiy to $eq only for json columns, which is a bit of a shame.
                        //! If this is fixed or changed, we can use the commented line below instead.
                        //[jsonColumnName]: params.findOperator,
                    }),
                }

                filter[dbColumnName] = [...(filter[column] || []), jsonParams]
            } else {
                filter[column] = [...(filter[column] || []), params]
            }

            if (token.suffix) {
                const lastFilterElement = filter[column].length - 1
                filter[column][lastFilterElement].findOperator = OperatorSymbolToFunction.get(token.suffix)(
                    filter[column][lastFilterElement].findOperator
                )
            }
        }
    }
    return filter
}

export function addFilter<T>(
    qb: SelectQueryBuilder<T>,
    query: PaginateQuery,
    filterableColumns?: { [column: string]: (FilterOperator | FilterSuffix)[] | true }
): ColumnJoinMethods {
    const filter = parseFilter(query, filterableColumns, qb)

    const filterEntries = Object.entries(filter)
    const orFilters = filterEntries.filter(([_, value]) => value[0].comparator === '$or')
    const andFilters = filterEntries.filter(([_, value]) => value[0].comparator === '$and')

    qb.andWhere(
        new Brackets((qb: SelectQueryBuilder<T>) => {
            for (const [column] of orFilters) {
                addWhereCondition(qb, column, filter)
            }
        })
    )

    for (const [column] of andFilters) {
        qb.andWhere(
            new Brackets((qb: SelectQueryBuilder<T>) => {
                addWhereCondition(qb, column, filter)
            })
        )
    }

    // Set the join type of every relationship used in a filter to `innerJoinAndSelect`
    // so that records without that relationships don't show up in filters on their columns.
    return Object.fromEntries(
        filterEntries
            .map(([key]) => [key, getPropertiesByColumnName(key)] as const)
            .filter(([, properties]) => properties.propertyPath)
            .flatMap(([, properties]) => {
                const nesting = properties.column.split('.')
                return Array.from({ length: nesting.length - 1 }, (_, i) => nesting.slice(0, i + 1).join('.'))
                    .filter((relation) => checkIsNestedRelation(qb, relation))
                    .map((relation) => [relation, 'innerJoinAndSelect'] as const)
            })
    )
}
