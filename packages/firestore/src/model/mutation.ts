/**
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Timestamp } from '../api/timestamp';
import { SnapshotVersion } from '../core/snapshot_version';
import { assert, fail } from '../util/assert';
import * as misc from '../util/misc';

import { Document, MaybeDocument, NoDocument } from './document';
import { DocumentKey } from './document_key';
import { FieldValue, ObjectValue, ServerTimestampValue } from './field_value';
import { FieldPath } from './path';

/**
 * Provides a set of fields that can be used to partially patch a document.
 * FieldMask is used in conjunction with ObjectValue.
 * Examples:
 *   foo - Overwrites foo entirely with the provided value. If foo is not
 *         present in the companion ObjectValue, the field is deleted.
 *   foo.bar - Overwrites only the field bar of the object foo.
 *             If foo is not an object, foo is replaced with an object
 *             containing foo
 */
export class FieldMask {
  constructor(readonly fields: FieldPath[]) {
    // TODO(dimond): validation of FieldMask
  }

  isEqual(other: FieldMask): boolean {
    return misc.arrayEquals(this.fields, other.fields);
  }
}

/** Represents a transform within a TransformMutation. */
export interface TransformOperation {
  isEqual(other: TransformOperation): boolean;
}

/** Transforms a value into a server-generated timestamp. */
export class ServerTimestampTransform implements TransformOperation {
  private constructor() {}
  static instance = new ServerTimestampTransform();

  isEqual(other: TransformOperation): boolean {
    return other instanceof ServerTimestampTransform;
  }
}

/** A field path and the TransformOperation to perform upon it. */
export class FieldTransform {
  constructor(
    readonly field: FieldPath,
    readonly transform: TransformOperation
  ) {}

  isEqual(other: FieldTransform): boolean {
    return (
      this.field.isEqual(other.field) && this.transform.isEqual(other.transform)
    );
  }
}

/** The result of successfully applying a mutation to the backend. */
export class MutationResult {
  constructor(
    /**
     * The version at which the mutation was committed or null for a delete.
     */
    readonly version: SnapshotVersion | null,
    /**
     * The resulting fields returned from the backend after a
     * TransformMutation has been committed. Contains one FieldValue for each
     * FieldTransform that was in the mutation.
     *
     * Will be null if the mutation was not a TransformMutation.
     */
    readonly transformResults: FieldValue[] | null
  ) {}
}

export enum MutationType {
  Set,
  Patch,
  Transform,
  Delete
}

/**
 * Encodes a precondition for a mutation. This follows the model that the
 * backend accepts with the special case of an explicit "empty" precondition
 * (meaning no precondition).
 */
export class Precondition {
  static readonly NONE = new Precondition();

  private constructor(
    readonly updateTime?: SnapshotVersion,
    readonly exists?: boolean
  ) {
    assert(
      updateTime === undefined || exists === undefined,
      'Precondition can specify "exists" or "updateTime" but not both'
    );
  }

  /** Creates a new Precondition with an exists flag. */
  static exists(exists: boolean): Precondition {
    return new Precondition(undefined, exists);
  }

  /** Creates a new Precondition based on a version a document exists at. */
  static updateTime(version: SnapshotVersion): Precondition {
    return new Precondition(version);
  }

  /** Returns whether this Precondition is empty. */
  get isNone(): boolean {
    return this.updateTime === undefined && this.exists === undefined;
  }

  /**
   * Returns true if the preconditions is valid for the given document
   * (or null if no document is available).
   */
  isValidFor(maybeDoc: MaybeDocument | null): boolean {
    if (this.updateTime !== undefined) {
      return (
        maybeDoc instanceof Document &&
        maybeDoc.version.isEqual(this.updateTime)
      );
    } else if (this.exists !== undefined) {
      if (this.exists) {
        return maybeDoc instanceof Document;
      } else {
        return maybeDoc === null || maybeDoc instanceof NoDocument;
      }
    } else {
      assert(this.isNone, 'Precondition should be empty');
      return true;
    }
  }

  isEqual(other: Precondition): boolean {
    return (
      misc.equals(this.updateTime, other.updateTime) &&
      this.exists === other.exists
    );
  }
}

/**
 * A mutation describes a self-contained change to a document. Mutations can
 * create, replace, delete, and update subsets of documents.
 *
 * Mutations not only act on the value of the document but also it version.
 * In the case of Set, Patch, and Transform mutations we preserve the existing
 * version. In the case of Delete mutations, we reset the version to 0.
 *
 * Here's the expected transition table.
 *
 * MUTATION           APPLIED TO            RESULTS IN
 *
 * SetMutation        Document(v3)          Document(v3)
 * SetMutation        NoDocument(v3)        Document(v0)
 * SetMutation        null                  Document(v0)
 * PatchMutation      Document(v3)          Document(v3)
 * PatchMutation      NoDocument(v3)        NoDocument(v3)
 * PatchMutation      null                  null
 * TransformMutation  Document(v3)          Document(v3)
 * TransformMutation  NoDocument(v3)        NoDocument(v3)
 * TransformMutation  null                  null
 * DeleteMutation     Document(v3)          NoDocument(v0)
 * DeleteMutation     NoDocument(v3)        NoDocument(v0)
 * DeleteMutation     null                  NoDocument(v0)
 *
 * Note that TransformMutations don't create Documents (in the case of being
 * applied to a NoDocument), even though they would on the backend. This is
 * because the client always combines the TransformMutation with a SetMutation
 * or PatchMutation and we only want to apply the transform if the prior
 * mutation resulted in a Document (always true for a SetMutation, but not
 * necessarily for a PatchMutation).
 *
 * ## Subclassing Notes
 *
 * Subclasses of Mutation need to implement applyToRemoteDocument() and
 * applyToLocalView() to implement the actual behavior of applying the mutation
 * to some source document.
 */
export abstract class Mutation {
  readonly type: MutationType;
  readonly key: DocumentKey;
  readonly precondition: Precondition;

  /**
   * Applies this mutation to the given MaybeDocument or null for the purposes
   * of computing a new remote document. Both the input and returned documents
   * can be null.
   *
   * @param maybeDoc The document to mutate. The input document can be null if
   *     the client has no knowledge of the pre-mutation state of the document.
   * @param mutationResult The result of applying the mutation from the backend.
   * @return The mutated document. The returned document may be null, but only
   *     if maybeDoc was null and the mutation would not create a new document.
   */
  abstract applyToRemoteDocument(
    maybeDoc: MaybeDocument | null,
    mutationResult: MutationResult
  ): MaybeDocument | null;

  /**
   * Applies this mutation to the given MaybeDocument or null for the purposes
   * of computing the new local view of a document. Both the input and returned
   * documents can be null.
   *
   * @param maybeDoc The document to mutate. The input document can be null if
   *     the client has no knowledge of the pre-mutation state of the document.
   * @param baseDoc The state of the document prior to this mutation batch. The
   *     input document can be null if the client has no knowledge of the
   *     pre-mutation state of the document.
   * @param localWriteTime A timestamp indicating the local write time of the
   *     batch this mutation is a part of.
   * @return The mutated document. The returned document may be null, but only
   *     if maybeDoc was null and the mutation would not create a new document.
   */
  abstract applyToLocalView(
    maybeDoc: MaybeDocument | null,
    baseDoc: MaybeDocument | null,
    localWriteTime: Timestamp
  ): MaybeDocument | null;

  abstract isEqual(other: Mutation): boolean;

  protected verifyKeyMatches(maybeDoc: MaybeDocument | null): void {
    if (maybeDoc != null) {
      assert(
        maybeDoc.key.isEqual(this.key),
        'Can only apply a mutation to a document with the same key'
      );
    }
  }

  /**
   * Returns the version from the given document for use as the result of a
   * mutation. Mutations are defined to return the version of the base document
   * only if it is an existing document. Deleted and unknown documents have a
   * post-mutation version of SnapshotVersion.MIN.
   */
  protected static getPostMutationVersion(
    maybeDoc: MaybeDocument | null
  ): SnapshotVersion {
    if (maybeDoc instanceof Document) {
      return maybeDoc.version;
    } else {
      return SnapshotVersion.MIN;
    }
  }
}

/**
 * A mutation that creates or replaces the document at the given key with the
 * object value contents.
 */
export class SetMutation extends Mutation {
  constructor(
    readonly key: DocumentKey,
    readonly value: ObjectValue,
    readonly precondition: Precondition
  ) {
    super();
  }

  readonly type: MutationType = MutationType.Set;

  applyToRemoteDocument(
    maybeDoc: MaybeDocument | null,
    mutationResult: MutationResult
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    assert(
      mutationResult.transformResults == null,
      'Transform results received by SetMutation.'
    );

    // Unlike applyToLocalView, if we're applying a mutation to a remote
    // document the server has accepted the mutation so the precondition must
    // have held.

    const version = Mutation.getPostMutationVersion(maybeDoc);
    return new Document(this.key, version, this.value, {
      hasLocalMutations: false
    });
  }

  applyToLocalView(
    maybeDoc: MaybeDocument | null,
    baseDoc: MaybeDocument | null,
    localWriteTime: Timestamp
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    if (!this.precondition.isValidFor(maybeDoc)) {
      return maybeDoc;
    }

    const version = Mutation.getPostMutationVersion(maybeDoc);
    return new Document(this.key, version, this.value, {
      hasLocalMutations: true
    });
  }

  isEqual(other: Mutation): boolean {
    return (
      other instanceof SetMutation &&
      this.key.isEqual(other.key) &&
      this.value.isEqual(other.value) &&
      this.precondition.isEqual(other.precondition)
    );
  }
}

/**
 * A mutation that modifies fields of the document at the given key with the
 * given values. The values are applied through a field mask:
 *
 *  * When a field is in both the mask and the values, the corresponding field
 *    is updated.
 *  * When a field is in neither the mask nor the values, the corresponding
 *    field is unmodified.
 *  * When a field is in the mask but not in the values, the corresponding field
 *    is deleted.
 *  * When a field is not in the mask but is in the values, the values map is
 *    ignored.
 */
export class PatchMutation extends Mutation {
  constructor(
    readonly key: DocumentKey,
    readonly data: ObjectValue,
    readonly fieldMask: FieldMask,
    readonly precondition: Precondition
  ) {
    super();
  }

  readonly type: MutationType = MutationType.Patch;

  applyToRemoteDocument(
    maybeDoc: MaybeDocument | null,
    mutationResult: MutationResult
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    assert(
      mutationResult.transformResults == null,
      'Transform results received by PatchMutation.'
    );

    // TODO(mcg): Relax enforcement of this precondition
    //
    // We shouldn't actually enforce the precondition since it already passed on
    // the backend, but we may not have a local version of the document to
    // patch, so we use the precondition to prevent incorrectly putting a
    // partial document into our cache.
    if (!this.precondition.isValidFor(maybeDoc)) {
      return maybeDoc;
    }

    const version = Mutation.getPostMutationVersion(maybeDoc);
    const newData = this.patchDocument(maybeDoc);
    return new Document(this.key, version, newData, {
      hasLocalMutations: false
    });
  }

  applyToLocalView(
    maybeDoc: MaybeDocument | null,
    baseDoc: MaybeDocument | null,
    localWriteTime: Timestamp
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    if (!this.precondition.isValidFor(maybeDoc)) {
      return maybeDoc;
    }

    const version = Mutation.getPostMutationVersion(maybeDoc);
    const newData = this.patchDocument(maybeDoc);
    return new Document(this.key, version, newData, {
      hasLocalMutations: true
    });
  }

  isEqual(other: Mutation): boolean {
    return (
      other instanceof PatchMutation &&
      this.key.isEqual(other.key) &&
      this.fieldMask.isEqual(other.fieldMask) &&
      this.precondition.isEqual(other.precondition)
    );
  }

  /**
   * Patches the data of document if available or creates a new document. Note
   * that this does not check whether or not the precondition of this patch
   * holds.
   */
  private patchDocument(maybeDoc: MaybeDocument | null): ObjectValue {
    let data: ObjectValue;
    if (maybeDoc instanceof Document) {
      data = maybeDoc.data;
    } else {
      data = ObjectValue.EMPTY;
    }
    return this.patchObject(data);
  }

  private patchObject(data: ObjectValue): ObjectValue {
    for (const fieldPath of this.fieldMask.fields) {
      const newValue = this.data.field(fieldPath);
      if (newValue !== undefined) {
        data = data.set(fieldPath, newValue);
      } else {
        data = data.delete(fieldPath);
      }
    }
    return data;
  }
}

/**
 * A mutation that modifies specific fields of the document with transform
 * operations. Currently the only supported transform is a server timestamp, but
 * IP Address, increment(n), etc. could be supported in the future.
 *
 * It is somewhat similar to a PatchMutation in that it patches specific fields
 * and has no effect when applied to a null or NoDocument (see comment on
 * Mutation for rationale).
 */
export class TransformMutation extends Mutation {
  readonly type: MutationType = MutationType.Transform;

  // NOTE: We set a precondition of exists: true as a safety-check, since we
  // always combine TransformMutations with a SetMutation or PatchMutation which
  // (if successful) should end up with an existing document.
  readonly precondition = Precondition.exists(true);

  constructor(
    readonly key: DocumentKey,
    readonly fieldTransforms: FieldTransform[]
  ) {
    super();
  }

  applyToRemoteDocument(
    maybeDoc: MaybeDocument | null,
    mutationResult: MutationResult
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    assert(
      mutationResult.transformResults != null,
      'Transform results missing for TransformMutation.'
    );
    const transformResults = mutationResult.transformResults!;

    // TODO(mcg): Relax enforcement of this precondition
    //
    // We shouldn't actually enforce the precondition since it already passed on
    // the backend, but we may not have a local version of the document to
    // patch, so we use the precondition to prevent incorrectly putting a
    // partial document into our cache.
    if (!this.precondition.isValidFor(maybeDoc)) {
      return maybeDoc;
    }

    const doc = this.requireDocument(maybeDoc);
    const newData = this.transformObject(doc.data, transformResults);
    return new Document(this.key, doc.version, newData, {
      hasLocalMutations: false
    });
  }

  applyToLocalView(
    maybeDoc: MaybeDocument | null,
    baseDoc: MaybeDocument | null,
    localWriteTime: Timestamp
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    if (!this.precondition.isValidFor(maybeDoc)) {
      return maybeDoc;
    }

    const doc = this.requireDocument(maybeDoc);
    const transformResults = this.localTransformResults(
      localWriteTime,
      baseDoc
    );
    const newData = this.transformObject(doc.data, transformResults);
    return new Document(this.key, doc.version, newData, {
      hasLocalMutations: true
    });
  }

  isEqual(other: Mutation): boolean {
    return (
      other instanceof TransformMutation &&
      this.key.isEqual(other.key) &&
      misc.arrayEquals(this.fieldTransforms, other.fieldTransforms) &&
      this.precondition.isEqual(other.precondition)
    );
  }

  /**
   * Asserts that the given MaybeDocument is actually a Document and verifies
   * that it matches the key for this mutation. Since we only support
   * transformations with precondition exists this method is guaranteed to be
   * safe.
   */
  private requireDocument(maybeDoc: MaybeDocument | null): Document {
    assert(
      maybeDoc instanceof Document,
      'Unknown MaybeDocument type ' + maybeDoc
    );
    const doc = maybeDoc! as Document;
    assert(
      doc.key.isEqual(this.key),
      'Can only transform a document with the same key'
    );
    return doc;
  }

  /**
   * Creates a list of "transform results" (a transform result is a field value
   * representing the result of applying a transform) for use when applying a
   * TransformMutation locally.
   *
   * @param localWriteTime The local time of the transform mutation (used to
   *     generate ServerTimestampValues).
   * @param baseDoc The document prior to applying this mutation batch.
   * @return The transform results list.
   */
  private localTransformResults(
    localWriteTime: Timestamp,
    baseDoc: MaybeDocument | null
  ): FieldValue[] {
    const transformResults = [] as FieldValue[];
    for (const fieldTransform of this.fieldTransforms) {
      const transform = fieldTransform.transform;
      if (transform instanceof ServerTimestampTransform) {
        let previousValue: FieldValue | null = null;

        if (baseDoc instanceof Document) {
          previousValue = baseDoc.field(fieldTransform.field) || null;
        }

        transformResults.push(
          new ServerTimestampValue(localWriteTime, previousValue)
        );
      } else {
        return fail('Encountered unknown transform: ' + transform);
      }
    }
    return transformResults;
  }

  private transformObject(
    data: ObjectValue,
    transformResults: FieldValue[]
  ): ObjectValue {
    assert(
      transformResults.length === this.fieldTransforms.length,
      'TransformResults length mismatch.'
    );

    for (let i = 0; i < this.fieldTransforms.length; i++) {
      const fieldTransform = this.fieldTransforms[i];
      const transform = fieldTransform.transform;
      const fieldPath = fieldTransform.field;
      if (transform instanceof ServerTimestampTransform) {
        data = data.set(fieldPath, transformResults[i]);
      } else {
        return fail('Encountered unknown transform: ' + transform);
      }
    }
    return data;
  }
}

/** A mutation that deletes the document at the given key. */
export class DeleteMutation extends Mutation {
  constructor(readonly key: DocumentKey, readonly precondition: Precondition) {
    super();
  }

  readonly type: MutationType = MutationType.Delete;

  applyToRemoteDocument(
    maybeDoc: MaybeDocument | null,
    mutationResult: MutationResult
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    assert(
      mutationResult.transformResults == null,
      'Transform results received by DeleteMutation.'
    );

    // Unlike applyToLocalView, if we're applying a mutation to a remote
    // document the server has accepted the mutation so the precondition must
    // have held.

    return new NoDocument(this.key, SnapshotVersion.MIN);
  }

  applyToLocalView(
    maybeDoc: MaybeDocument | null,
    baseDoc: MaybeDocument | null,
    localWriteTime: Timestamp
  ): MaybeDocument | null {
    this.verifyKeyMatches(maybeDoc);

    if (!this.precondition.isValidFor(maybeDoc)) {
      return maybeDoc;
    }

    if (maybeDoc) {
      assert(
        maybeDoc.key.isEqual(this.key),
        'Can only apply mutation to document with same key'
      );
    }
    return new NoDocument(this.key, SnapshotVersion.forDeletedDoc());
  }

  isEqual(other: Mutation): boolean {
    return (
      other instanceof DeleteMutation &&
      this.key.isEqual(other.key) &&
      this.precondition.isEqual(other.precondition)
    );
  }
}
